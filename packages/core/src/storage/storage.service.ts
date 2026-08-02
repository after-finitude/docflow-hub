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
  private readonly client: Client

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
      this.logger.log(`Создан bucket ${bucket}`)
    }
  }

  async put(key: string, body: Buffer | Readable, contentType: string): Promise<void> {
    await this.client.putObject(this.env.MINIO_BUCKET, key, body, undefined, {
      'Content-Type': contentType,
    })
  }

  async getStream(key: string): Promise<Readable> {
    return this.client.getObject(this.env.MINIO_BUCKET, key)
  }

  /** Подписанная ссылка со сроком SIGNED_URL_TTL_SECONDS (по умолчанию 15 минут). */
  async signedUrl(key: string): Promise<string> {
    return this.client.presignedGetObject(
      this.env.MINIO_BUCKET,
      key,
      this.env.SIGNED_URL_TTL_SECONDS,
    )
  }

  async remove(key: string): Promise<void> {
    await this.client.removeObject(this.env.MINIO_BUCKET, key)
  }
}
