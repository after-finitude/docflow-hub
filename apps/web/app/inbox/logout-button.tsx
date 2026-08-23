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
      <button type="button" onClick={handleLogout} className="btn btn--ghost btn--sm">
        Sign out
      </button>
      {failed && <p className="mt-1 text-xs text-danger">Could not sign out. Try again</p>}
    </div>
  )
}
