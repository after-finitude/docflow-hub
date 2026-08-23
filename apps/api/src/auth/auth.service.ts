import { DB, hashPassword, users, verifyPassword, writeAudit, type Database } from '@docflow/core'
import type { JwtPayload, SessionUser } from '@docflow/shared'
import { Inject, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { RequestContext } from './decorators'

/**
 * Login attempt result. It distinguishes an unknown account from a wrong password
 * for auditing only; the client response is identical. See recordAttempt.
 */
export type LoginOutcome =
  | { status: 'success'; user: SessionUser }
  | { status: 'bad_password'; login: string }
  | { status: 'unknown_login' }

export interface IssuedSession {
  token: string
  expiresAt: Date
  user: SessionUser
}

@Injectable()
export class AuthService {
  /**
   * Hash of a random value used for unknown usernames so response timing does
   * not reveal which accounts exist.
   */
  private readonly decoyHash: Promise<string> = hashPassword(randomBytes(32).toString('hex'))

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  async attemptLogin(login: string, password: string): Promise<LoginOutcome> {
    const [user] = await this.db.select().from(users).where(eq(users.login, login)).limit(1)

    if (!user) {
      await verifyPassword(password, await this.decoyHash)
      return { status: 'unknown_login' }
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      return { status: 'bad_password', login: user.login }
    }

    return { status: 'success', user: { id: user.id, login: user.login, role: user.role } }
  }

  async issueSession(user: SessionUser): Promise<IssuedSession> {
    const payload: JwtPayload = { sub: user.id, login: user.login, role: user.role }
    const token = await this.jwt.signAsync(payload)

    const decoded = this.jwt.decode(token) as { exp?: unknown } | null
    if (typeof decoded?.exp !== 'number') {
      throw new Error('JWT was issued without exp; check JWT_EXPIRES_IN')
    }

    return { token, expiresAt: new Date(decoded.exp * 1000), user }
  }

  /**
   * Audit a login attempt. Store the username only for an existing account:
   * users sometimes type passwords into this field, and audit rows are immutable
   * and cannot be deleted (spec §11).
   */
  async recordAttempt(outcome: LoginOutcome, origin: RequestContext): Promise<void> {
    const known = outcome.status !== 'unknown_login'
    await writeAudit(this.db, {
      correlationId: origin.correlationId,
      actorType: 'user',
      actorId: outcome.status === 'success' ? outcome.user.id : undefined,
      action: 'auth.login',
      objectType: 'user',
      objectId: outcome.status === 'success' ? outcome.user.id : undefined,
      after: known
        ? { login: outcome.status === 'success' ? outcome.user.login : outcome.login }
        : { accountExists: false },
      result: outcome.status === 'success' ? 'success' : 'failure',
      ip: origin.ip,
      userAgent: origin.userAgent,
    })
  }

  async recordLogout(user: SessionUser | undefined, origin: RequestContext): Promise<void> {
    await writeAudit(this.db, {
      correlationId: origin.correlationId,
      actorType: 'user',
      actorId: user?.id,
      action: 'auth.logout',
      objectType: 'user',
      objectId: user?.id,
      // Logging out with an invalid session is normal and is still audited so
      // a login is not left without a matching logout.
      after: user ? undefined : { sessionAlreadyInvalid: true },
      result: 'success',
      ip: origin.ip,
      userAgent: origin.userAgent,
    })
  }
}
