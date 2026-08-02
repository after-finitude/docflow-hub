import type { SessionUser } from '@docflow/shared'
import { cookies } from 'next/headers'

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001'

/**
 * Три состояния, а не два. Отличать «сессии нет» от «бэкенд недоступен»
 * обязательно: если считать недоступность отсутствием сессии, перезапуск
 * контейнера api выбрасывал бы на форму входа пользователей с валидной
 * сессией — и уводил бы диагностику в ложную сторону.
 */
export type SessionState =
  | { status: 'authenticated'; user: SessionUser }
  | { status: 'anonymous' }
  | { status: 'unavailable' }

export async function readSession(): Promise<SessionState> {
  const cookieStore = await cookies()

  let response: Response
  try {
    response = await fetch(`${apiUrl}/auth/me`, {
      headers: { cookie: cookieStore.toString() },
      cache: 'no-store',
      // Без таймаута зависший API (не отказ соединения, а молчание) держал бы
      // рендер до таймаута undici — около пяти минут, и экран «недоступен»
      // как раз в худшем случае не показался бы.
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    return { status: 'unavailable' }
  }

  if (response.status === 401) return { status: 'anonymous' }
  if (!response.ok) return { status: 'unavailable' }

  return { status: 'authenticated', user: (await response.json()) as SessionUser }
}
