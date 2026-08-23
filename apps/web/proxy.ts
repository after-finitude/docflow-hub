import { SESSION_COOKIE_NAME } from '@docflow/shared'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Next.js 16 uses proxy.ts instead of middleware.ts and supports only the Node.js runtime here.
 *
 * There is only one redirect: no cookie means login. The reverse rule is
 * intentionally absent because a cookie does not prove validity. Pages verify
 * sessions through the API; a second source of truth would cause redirect loops
 * for expired sessions. Only the API decides validity, so this merely protects
 * navigation and a forged cookie grants nothing.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  if (!request.cookies.has(SESSION_COOKIE_NAME) && pathname !== '/login') {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

export const config = {
  // Segment boundaries keep a future /api-docs route from silently bypassing this check.
  matcher: ['/((?!api/|_next/|favicon\\.ico$).*)'],
}
