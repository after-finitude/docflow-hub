'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function LogoutButton() {
  const router = useRouter()
  const [failed, setFailed] = useState(false)

  async function handleLogout() {
    setFailed(false)
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' })
      if (!response.ok) {
        setFailed(true)
        return
      }
    } catch {
      setFailed(true)
      return
    }

    router.replace('/login')
    router.refresh()
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={handleLogout}
        className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-sm hover:bg-neutral-100"
      >
        Выйти
      </button>
      {failed && <p className="mt-1 text-xs text-red-600">Не удалось выйти, повторите</p>}
    </div>
  )
}
