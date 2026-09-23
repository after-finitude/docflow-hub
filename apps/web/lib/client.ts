export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number | null; message: string }

/**
 * Browser call through the `/api` rewrite: one place for JSON parsing and error
 * text. The server's `message` wins; `fallback` covers errors without one.
 */
export async function apiCall<T>(
  path: string,
  init: RequestInit = {},
  fallback?: string,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    })
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: body?.message ?? fallback ?? `Error ${response.status}`,
      }
    }
    return { ok: true, data: body as T }
  } catch {
    return { ok: false, status: null, message: 'Service unavailable' }
  }
}
