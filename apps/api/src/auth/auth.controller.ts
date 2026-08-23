import { ENV, type Env } from '@docflow/core'
import {
  SESSION_COOKIE_NAME,
  loginRequestSchema,
  type LoginRequest,
  type SessionUser,
} from '@docflow/shared'
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import type { CookieOptions, Response } from 'express'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { AuthService } from './auth.service'
import {
  CurrentUser,
  OptionalAuth,
  Origin,
  Public,
  type AuthenticatedRequest,
  type RequestContext,
} from './decorators'
import { LoginThrottlerGuard } from './login-throttler.guard'

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  // Rate limiting prevents scrypt cost from being the password's only protection.
  @UseGuards(LoginThrottlerGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Origin() origin: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionUser> {
    const outcome = await this.auth.attemptLogin(body.login, body.password)
    await this.auth.recordAttempt(outcome, origin)

    if (outcome.status !== 'success') {
      // Return the same response for an unknown username and a wrong password.
      throw new UnauthorizedException('Invalid username or password')
    }

    const session = await this.auth.issueSession(outcome.user)
    res.cookie(SESSION_COOKIE_NAME, session.token, {
      ...this.cookieOptions(),
      expires: session.expiresAt,
    })
    return outcome.user
  }

  /**
   * Logout must work with an invalid session so a user with an expired token
   * can still clear the cookie and sign in again.
   */
  @OptionalAuth()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @CurrentUser() user: SessionUser | undefined,
    @Origin() origin: RequestContext,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    // Audit only when a cookie existed. Otherwise unauthenticated requests could
    // fill an append-only table that the application cannot purge (spec §11).
    if (request.cookies?.[SESSION_COOKIE_NAME]) {
      await this.auth.recordLogout(user, origin)
    }
    res.clearCookie(SESSION_COOKIE_NAME, this.cookieOptions())
  }

  /** Current session used by the frontend to render navigation and permissions. */
  @Get('me')
  me(@CurrentUser() user: SessionUser): SessionUser {
    return user
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.env.COOKIE_SECURE,
      path: '/',
    }
  }
}
