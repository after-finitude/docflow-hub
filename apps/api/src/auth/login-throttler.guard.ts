import { Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'

/**
 * Ограничение частоты входа считается по логину, а не по адресу.
 *
 * Причина: браузер обращается к API через rewrite Next.js, а тот не проставляет
 * X-Forwarded-For (создаёт прокси без опции xfwd). Адресом клиента для API
 * всегда оказывается контейнер web, поэтому лимит по IP был бы общим на всю
 * установку — одиннадцатый вход подряд отказывал бы постороннему пользователю.
 * Доверять же заголовку от клиента нельзя: он подделывается тривиально.
 *
 * Логин из тела запроса подделать в свою пользу невозможно — подставив чужой,
 * атакующий ограничит сам себя. Ценой остаётся возможность занять лимит
 * конкретной учётной записи; при 10 попытках в минуту это приемлемо.
 */
@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const body = req.body as { login?: unknown } | undefined
    const login = typeof body?.login === 'string' ? body.login.trim().toLowerCase() : ''
    return login ? `login:${login}` : `peer:${String(req.ip ?? 'unknown')}`
  }
}
