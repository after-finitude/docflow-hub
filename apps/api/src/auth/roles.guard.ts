import type { UserRole } from '@docflow/shared'
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ROLES_KEY, type AuthenticatedRequest } from './decorators'

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required?.length) return true

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Insufficient permissions for this action')
    }
    return true
  }
}
