import { DB, users, type Database } from '@docflow/core'
import { SESSION_COOKIE_NAME, type JwtPayload } from '@docflow/shared'
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { eq } from 'drizzle-orm'
import { IS_OPTIONAL_AUTH_KEY, IS_PUBLIC_KEY, type AuthenticatedRequest } from './decorators'

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(DB) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.hasMetadata(context, IS_PUBLIC_KEY)) return true
    const optional = this.hasMetadata(context, IS_OPTIONAL_AUTH_KEY)

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const token = request.cookies?.[SESSION_COOKIE_NAME] as string | undefined
    if (!token) return this.reject(optional, 'Требуется вход в систему')

    let payload: JwtPayload
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token)
    } catch {
      return this.reject(optional, 'Сессия недействительна или истекла')
    }

    // Роль и само существование пользователя перечитываются из БД: иначе
    // понижение прав или удаление учётной записи вступали бы в силу только
    // после истечения токена.
    const [user] = await this.db
      .select({ id: users.id, login: users.login, role: users.role })
      .from(users)
      .where(eq(users.id, payload.sub))
      .limit(1)

    if (!user) return this.reject(optional, 'Учётная запись недоступна')

    request.user = user
    return true
  }

  private hasMetadata(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) ===
      true
    )
  }

  private reject(optional: boolean, message: string): boolean {
    if (optional) return true
    throw new UnauthorizedException(message)
  }
}
