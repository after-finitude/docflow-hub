import type { SessionUser, UserRole } from '@docflow/shared'
import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

export const IS_PUBLIC_KEY = 'auth:public'
export const IS_OPTIONAL_AUTH_KEY = 'auth:optional'
export const ROLES_KEY = 'auth:roles'

/** Эндпоинт доступен без аутентификации (логин, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

/**
 * Аутентификация необязательна: обработчик выполняется и с недействительной
 * сессией, но получает пользователя, если она валидна. Нужно для выхода —
 * очистить cookie обязано быть возможно именно тогда, когда токен уже протух.
 */
export const OptionalAuth = () => SetMetadata(IS_OPTIONAL_AUTH_KEY, true)

/** Ограничение по роли, ТЗ 3.1: действия администратора недоступны оператору. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles)

export interface AuthenticatedRequest extends Request {
  user?: SessionUser
  correlationId?: string
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
)

/** Происхождение запроса — попадает в журнал вместе с действием. */
export interface RequestContext {
  ip?: string
  userAgent?: string
  correlationId?: string
}

export const Origin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>()
    return {
      ip: request.ip,
      userAgent: request.get('user-agent'),
      correlationId: request.correlationId,
    }
  },
)
