import { cookies } from 'next/headers'

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001'

/**
 * Серверный запрос к API с пробросом cookie текущего пользователя.
 * Таймаут обязателен: без него зависший бэкенд держал бы рендер страницы.
 */
export async function apiFetch(path: string, timeoutMs = 5000): Promise<Response> {
  const cookieStore = await cookies()
  return fetch(`${apiUrl}${path}`, {
    headers: { cookie: cookieStore.toString() },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
}
