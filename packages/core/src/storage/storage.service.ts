import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { Client } from 'minio'
import type { Readable } from 'node:stream'
import { ENV } from '../config/config.module'
import type { Env } from '../config/env'

/**
 * Объектное хранилище оригиналов и миниатюр. Ссылки на файлы выдаются
 * подписанными и с ограниченным сроком жизни (ТЗ §11).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name)
  /** Внутренний клиент: чтение и запись из контейнеров. */
  private readonly client: Client
  /**
   * Клиент для подписи ссылок, отдаваемых браузеру. Отдельный, потому что
   * подпись покрывает Host: ссылку, подписанную адресом minio:9000, браузер
   * открыть не сможет.
   */
  private readonly publicClient: Client

  constructor(@Inject(ENV) private readonly env: Env) {
    this.client = new Client({
      endPoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSSL: env.MINIO_USE_SSL,
      accessKey: env.MINIO_ROOT_USER,
      secretKey: env.MINIO_ROOT_PASSWORD,
    })

    const publicUrl = new URL(env.MINIO_PUBLIC_URL)
    const useSSL = publicUrl.protocol === 'https:'
    this.publicClient = new Client({
      endPoint: publicUrl.hostname,
      port: Number(publicUrl.port) || (useSSL ? 443 : 80),
      useSSL,
      accessKey: env.MINIO_ROOT_USER,
      secretKey: env.MINIO_ROOT_PASSWORD,
    })
  }

  async onModuleInit(): Promise<void> {
    const bucket = this.env.MINIO_BUCKET
    if (!(await this.client.bucketExists(bucket))) {
      await this.client.makeBucket(bucket)
      this.logger.log(`Создан bucket ${bucket}`)
    }
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

  /** Подписанная ссылка для браузера, срок — SIGNED_URL_TTL_SECONDS. */
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
}
