'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

export function LoginForm() {
  const router = useRouter()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      })

      if (response.ok) {
        router.replace('/inbox')
        router.refresh()
        return
      }

      if (response.status === 401) setError('Invalid username or password')
      else if (response.status === 429) setError('Too many attempts. Try again later')
      else setError('Could not sign in')
    } catch {
      // Without this branch, a network error would leave the button disabled
      // forever because setPending(false) below would never run.
      setError('Service unavailable. Try again later')
    }

    setPending(false)
  }

  return (
    // Place the form in the left third at 18vh instead of centering it like a poster.
    <main className="min-h-screen px-6 pt-[18vh] pb-16">
      <div className="mx-auto max-w-[1600px]">
        <form onSubmit={handleSubmit} className="max-w-[22rem]">
          <h1 className="flex items-baseline gap-2">
            <span className="font-display text-xl font-semibold tracking-tight">Docflow</span>
            <span className="mono text-2xs uppercase tracking-[0.14em] text-muted">hub</span>
          </h1>
          <p className="mt-1 text-sm text-muted">Document ingest, recognition, and review</p>

          <div className="mt-8 space-y-4">
            <div>
              <label className="label mb-1" htmlFor="login">
                Username
              </label>
              <input
                id="login"
                name="login"
                autoComplete="username"
                required
                aria-invalid={error !== null}
                aria-describedby="auth-error"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                className="field"
              />
            </div>

            <div>
              <label className="label mb-1" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                aria-invalid={error !== null}
                aria-describedby="auth-error"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="field"
              />
            </div>
          </div>

          {/* Reserve the message row so an error does not move the button under the cursor. */}
          <p
            id="auth-error"
            role={error ? 'alert' : undefined}
            className="mt-3 min-h-[1.25rem] text-xs text-danger"
          >
            {error}
          </p>

          <button type="submit" disabled={pending} className="btn btn--primary mt-2 w-full">
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  )
}
