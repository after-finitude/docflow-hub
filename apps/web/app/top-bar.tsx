import type { SessionUser } from '@docflow/shared'
import Link from 'next/link'
import { LogoutButton } from './inbox/logout-button'

/**
 * Верхняя панель рабочих экранов: плоская, с одной волосяной линией снизу.
 * Не «плавающая пилюля» — это инструмент, панель обязана стоять на месте
 * и всегда занимать одну и ту же высоту.
 */
export function TopBar({ user, active }: { user: SessionUser; active: 'inbox' | 'runs' }) {
  return (
    <header className="sticky top-0 z-10 border-b border-rule bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-6">
        <Link href="/inbox" className="flex items-baseline gap-2">
          <span className="font-display text-[0.9375rem] font-semibold tracking-tight">
            Docflow
          </span>
          <span className="mono text-2xs uppercase tracking-[0.14em] text-muted">hub</span>
        </Link>

        <nav className="flex items-center gap-1">
          <TabLink href="/inbox" current={active === 'inbox'}>
            Очередь
          </TabLink>
          <TabLink href="/runs" current={active === 'runs'}>
            Журнал
          </TabLink>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-xs text-muted sm:inline">
            {user.login}
            <span className="mx-1.5 text-rule-2">·</span>
            {user.role === 'admin' ? 'администратор' : 'оператор'}
          </span>
          <LogoutButton />
        </div>
      </div>
    </header>
  )
}

/** Активный раздел помечен акцентом — это одно из немногих его применений. */
function TabLink({
  href,
  current,
  children,
}: {
  href: string
  current: boolean
  children: string
}) {
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`rounded-[6px] px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors duration-[120ms] ${
        current ? 'bg-accent-wash text-accent' : 'text-ink-2 hover:bg-paper-2 hover:text-ink'
      }`}
    >
      {children}
    </Link>
  )
}
