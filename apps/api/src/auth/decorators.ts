import type { SessionUser, UserRole } from '@docflow/shared'
import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'

export const IS_PUBLIC_KEY = 'auth:public'
export const IS_OPTIONAL_AUTH_KEY = 'auth:optional'
export const ROLES_KEY = 'auth:roles'

/** Endpoint available without authentication (login and health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

/**
 * Authentication is optional: the handler runs for invalid sessions but receives
 * the user when valid. Logout needs this so an expired token can be cleared.
 */
export const OptionalAuth = () => SetMetadata(IS_OPTIONAL_AUTH_KEY, true)

/** Role restriction, spec 3.1: operators cannot perform administrator actions. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles)

export interface AuthenticatedRequest extends Request {
  user?: SessionUser
  correlationId?: string
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
)

/** Request origin, stored in the audit log with the action. */
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
