import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import 'reflect-metadata'
import { AppModule } from './app.module'

/**
 * Воркеры pipeline. Отдельный контейнер без HTTP-сервера (требование ТЗ):
 * standalone-приложение Nest, обработчики очередей подключаются на этапах 3–7.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule)
  app.enableShutdownHooks()
  new Logger('Bootstrap').log('Воркер запущен')
}

void bootstrap()
