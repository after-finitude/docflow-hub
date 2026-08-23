import type { SessionUser } from '@docflow/shared'
import Link from 'next/link'
import { LogoutButton } from './inbox/logout-button'

/**
 * Top bar for work screens: flat, with a single hairline border below.
 * It is a fixed tool rather than a floating pill and always has the same height.
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
            Queue
          </TabLink>
          <TabLink href="/runs" current={active === 'runs'}>
            Log
          </TabLink>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-xs text-muted sm:inline">
            {user.login}
            <span className="mx-1.5 text-rule-2">·</span>
            {user.role === 'admin' ? 'administrator' : 'operator'}
          </span>
          <LogoutButton />
        </div>
      </div>
    </header>
  )
}

/** The active section uses the accent color, one of its few uses. */
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
