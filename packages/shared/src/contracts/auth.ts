import { z } from 'zod'
import { USER_ROLES, type UserRole } from '../enums'

export const loginRequestSchema = z.object({
  login: z.string().min(1, 'Введите логин'),
  password: z.string().min(1, 'Введите пароль'),
})
export type LoginRequest = z.infer<typeof loginRequestSchema>

export const sessionUserSchema = z.object({
  id: z.string(),
  login: z.string(),
  role: z.enum(USER_ROLES),
})
export type SessionUser = z.infer<typeof sessionUserSchema>

/** Полезная нагрузка JWT: sub — id пользователя. */
export interface JwtPayload {
  sub: string
  login: string
  role: UserRole
}
