import type { SessionUser } from '@docflow/shared'
import { cookies } from 'next/headers'

const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001'

/**
 * There are three states, not two. “No session” must remain distinct from
 * “backend unavailable”; otherwise an API container restart would send users
 * with valid sessions to login and point diagnostics in the wrong direction.
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
      // Without a timeout, a silent API would block rendering until undici's
      // roughly five-minute timeout, hiding the unavailable screen when needed most.
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    return { status: 'unavailable' }
  }

  if (response.status === 401) return { status: 'anonymous' }
  if (!response.ok) return { status: 'unavailable' }

  return { status: 'authenticated', user: (await response.json()) as SessionUser }
}
