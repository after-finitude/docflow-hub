import { ENV, type Env } from '@docflow/core'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import cookieParser from 'cookie-parser'
import 'reflect-metadata'
import { AppModule } from './app.module'
import { correlationMiddleware } from './common/correlation.middleware'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  const env = app.get<Env>(ENV)

  // Do not enable trust proxy: Next.js rewrites do not set X-Forwarded-For, so
  // trusting it would accept a client-supplied value, bypass login limits, and
  // record a forged address. LoginThrottlerGuard limits by username instead.

  app.use(cookieParser())
  app.use(correlationMiddleware)
  app.enableShutdownHooks()

  await app.listen(env.API_PORT, '0.0.0.0')
  new Logger('Bootstrap').log(`API listening on port ${env.API_PORT}`)
}

void bootstrap()
