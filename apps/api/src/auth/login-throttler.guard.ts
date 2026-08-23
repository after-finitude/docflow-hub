import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

/**
 * Login rate limits are keyed by username rather than IP address.
 *
 * Next.js rewrites do not set X-Forwarded-For, so the API always sees the web
 * container. An IP limit would be shared by the entire installation, while a
 * client-provided header cannot be trusted.
 *
 * Spoofing another username does not help an attacker authenticate. It can
 * exhaust one account's limit, an acceptable trade-off at 10 attempts per minute.
 */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const body = req.body as { login?: unknown } | undefined
    const login = typeof body?.login === 'string' ? body.login.trim().toLowerCase() : ''
    return login ? `login:${login}` : `peer:${String(req.ip ?? 'unknown')}`
  }
}
