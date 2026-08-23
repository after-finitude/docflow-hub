import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { Client } from 'minio'
import type { Readable } from 'node:stream'
import { ENV } from '../config/config.module'
import type { Env } from '../config/env'

/**
 * Object storage for originals and thumbnails. File links are signed and
 * short-lived (spec §11).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name)
  /** Internal client for reads and writes from containers. */
  private readonly client: Client
  /**
   * Separate client for browser link signing because signatures cover Host and
   * browsers cannot open a URL signed for minio:9000.
   */
  private publicClient!: Client

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client = new Client({
      endPoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSSL: env.MINIO_USE_SSL,
      accessKey: env.MINIO_ROOT_USER,
      secretKey: env.MINIO_ROOT_PASSWORD,
    })
  }

  async onModuleInit(): Promise<void> {
    const bucket = this.env.MINIO_BUCKET
    if (!(await this.client.bucketExists(bucket))) {
      await this.client.makeBucket(bucket)
      this.logger.log(`Created bucket ${bucket}`)
    }

    // Resolve the region with the internal client and pass it to the public one;
    // MINIO_PUBLIC_URL may be unreachable from inside the container.
    const region = await this.client.getBucketRegionAsync(bucket)
    const publicUrl = new URL(this.env.MINIO_PUBLIC_URL)
    const useSSL = publicUrl.protocol === 'https:'
    this.publicClient = new Client({
      endPoint: publicUrl.hostname,
      port: Number(publicUrl.port) || (useSSL ? 443 : 80),
      useSSL,
      region,
      accessKey: this.env.MINIO_ROOT_USER,
      secretKey: this.env.MINIO_ROOT_PASSWORD,
    })
  }

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<void> {
    await this.client.putObject(this.env.MINIO_BUCKET, key, body, undefined, {
      'Content-Type': contentType,
    })
  }

  async getBuffer(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.env.MINIO_BUCKET, key)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }

  async getStream(key: string): Promise<Readable> {
    return this.client.getObject(this.env.MINIO_BUCKET, key)
  }

  /** Browser signed URL valid for SIGNED_URL_TTL_SECONDS. */
  async signedUrl(key: string): Promise<string> {
    return this.publicClient.presignedGetObject(
      this.env.MINIO_BUCKET,
      key,
      this.env.SIGNED_URL_TTL_SECONDS,
    )
  }

  async remove(key: string): Promise<void> {
    await this.client.removeObject(this.env.MINIO_BUCKET, key)
  }

  /** List objects under a prefix for retention (spec 6.9). */
  async list(prefix: string): Promise<{ key: string; lastModified: Date }[]> {
    const stream = this.client.listObjectsV2(this.env.MINIO_BUCKET, prefix, true)
    const items: { key: string; lastModified: Date }[] = []
    for await (const item of stream) {
      if (item.name) items.push({ key: item.name, lastModified: item.lastModified })
    }
    return items
  }

  /** All document files share a prefix and are deleted in one call. */
  async removePrefix(prefix: string): Promise<number> {
    const keys = (await this.list(prefix)).map((item) => item.key)
    if (keys.length) await this.client.removeObjects(this.env.MINIO_BUCKET, keys)
    return keys.length
  }
}
