import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'reflect-metadata'
import { AppModule } from './app.module'

/** The Compose healthcheck reads this file's age; keep both paths and intervals in step. */
const HEARTBEAT_FILE = join(tmpdir(), 'docflow-worker-heartbeat')
const HEARTBEAT_INTERVAL_MS = 10_000

/**
 * Pipeline workers in a separate container without an HTTP server, as required
 * by the spec. Queue processors are registered in stages 3–7.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule)
  app.enableShutdownHooks()
  const logger = new Logger('Bootstrap')
  // Written only after bootstrap, so the container turns healthy once the
  // processors are registered, and stays healthy while the event loop runs.
  const beat = () =>
    writeFile(HEARTBEAT_FILE, '').catch((error: unknown) =>
      logger.warn(`Heartbeat write failed: ${String(error)}`),
    )
  await beat()
  setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS).unref()
  logger.log('Worker started')
}

void bootstrap()
