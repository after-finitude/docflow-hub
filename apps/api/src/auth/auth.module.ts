import { ENV, type Env } from '@docflow/core'
import { Module } from '@nestjs/common'
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt'
import { ThrottlerModule } from '@nestjs/throttler'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'

@Module({
  imports: [
    // global: true because the global JwtAuthGuard needs JwtService.
    JwtModule.registerAsync({
      global: true,
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        // The ms library validates values such as '8h' at runtime.
        signOptions: { expiresIn: env.JWT_EXPIRES_IN as JwtSignOptions['expiresIn'] },
      }),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        throttlers: [{ limit: env.LOGIN_RATE_LIMIT, ttl: env.LOGIN_RATE_WINDOW_SECONDS * 1000 }],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
