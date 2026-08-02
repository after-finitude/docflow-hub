import { SESSION_COOKIE_NAME } from '@docflow/shared'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Next.js 16: proxy.ts вместо middleware.ts, runtime только nodejs.
 *
 * Здесь только один переход: без cookie — на форму входа. Обратного правила
 * («cookie есть — уводить с /login») намеренно нет. Наличие cookie ничего
 * не говорит о её действительности, а страницы проверяют сессию через API,
 * поэтому два источника правды зациклили бы редиректы на любой протухшей
 * сессии. Решение о действительности принимает только API; отсюда — исключительно
 * защита навигации, подделка cookie ничего не даёт.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  if (!request.cookies.has(SESSION_COOKIE_NAME) && pathname !== '/login') {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

export const config = {
  // Границы сегментов обязательны: без них будущий маршрут /api-docs
  // молча оказался бы вне проверки.
  matcher: ['/((?!api/|_next/|favicon\\.ico$).*)'],
}
