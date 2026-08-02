import { DB, hashPassword, users, verifyPassword, writeAudit, type Database } from '@docflow/core'
import type { JwtPayload, SessionUser } from '@docflow/shared'
import { Inject, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { RequestContext } from './decorators'

/**
 * Исход попытки входа. Различает «нет такой учётной записи» и «пароль неверен»
 * не для ответа клиенту — тот в обоих случаях одинаков, — а для журнала:
 * логин несуществующей учётной записи записывать нельзя, см. recordAttempt.
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
   * Хэш от случайного значения. Проверка пароля против него выполняется при
   * несуществующем логине, чтобы ответ занимал столько же времени, сколько
   * при существующем: иначе учётные записи перечисляются по времени ответа.
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
      throw new Error('JWT выпущен без exp: проверьте значение JWT_EXPIRES_IN')
    }

    return { token, expiresAt: new Date(decoded.exp * 1000), user }
  }

  /**
   * Журнал попытки входа. Логин пишется только когда учётная запись существует:
   * в поле логина регулярно по ошибке набирают пароль, а таблица журнала
   * не допускает ни изменения, ни удаления записей (ТЗ §11).
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
      // Выход с уже недействительной сессией — штатный случай, он тоже
      // должен попадать в журнал, иначе вход остаётся без парного выхода.
      after: user ? undefined : { sessionAlreadyInvalid: true },
      result: 'success',
      ip: origin.ip,
      userAgent: origin.userAgent,
    })
  }
}
