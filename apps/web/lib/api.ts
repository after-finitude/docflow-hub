import { cookies } from 'next/headers'

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001'

/**
 * Server-side API request forwarding the current user's cookie.
 * A timeout prevents a stalled backend from blocking page rendering.
 */
export async function apiFetch(path: string, timeoutMs = 5000): Promise<Response> {
  const cookieStore = await cookies()
  return fetch(`${apiUrl}${path}`, {
    headers: { cookie: cookieStore.toString() },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  })
}
