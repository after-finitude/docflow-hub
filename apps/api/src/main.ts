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

  // trust proxy намеренно не включается: rewrite Next.js не проставляет
  // X-Forwarded-For, поэтому доверие к этому заголовку означало бы доверие
  // к значению, которое клиент задаёт сам, — с обходом ограничения частоты
  // входа и подложным адресом в журнале. Ограничение считается по логину,
  // см. LoginThrottlerGuard.

  app.use(cookieParser())
  app.use(correlationMiddleware)
  app.enableShutdownHooks()

  await app.listen(env.API_PORT, '0.0.0.0')
  new Logger('Bootstrap').log(`API слушает порт ${env.API_PORT}`)
}

void bootstrap()
