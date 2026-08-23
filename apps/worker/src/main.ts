import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import 'reflect-metadata'
import { AppModule } from './app.module'

/**
 * Pipeline workers in a separate container without an HTTP server, as required
 * by the spec. Queue processors are registered in stages 3–7.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule)
  app.enableShutdownHooks()
  new Logger('Bootstrap').log('Worker started')
}

void bootstrap()
