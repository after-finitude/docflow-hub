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

      if (response.status === 401) setError('Неверный логин или пароль')
      else if (response.status === 429) setError('Слишком много попыток, попробуйте позже')
      else setError('Не удалось войти')
    } catch {
      // Без этой ветки сетевая ошибка оставила бы кнопку заблокированной
      // навсегда: setPending(false) ниже не выполнился бы.
      setError('Сервис недоступен, попробуйте позже')
    }

    setPending(false)
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 shadow-sm"
      >
        <h1 className="text-xl font-semibold">Docflow Hub</h1>
        <p className="mt-1 mb-6 text-sm text-neutral-500">Вход в систему</p>

        <label className="block text-sm font-medium" htmlFor="login">
          Логин
        </label>
        <input
          id="login"
          name="login"
          autoComplete="username"
          required
          value={login}
          onChange={(event) => setLogin(event.target.value)}
          className="mt-1 mb-4 w-full rounded-md border border-[var(--color-border-subtle)] px-3 py-2 outline-none focus:border-neutral-500"
        />

        <label className="block text-sm font-medium" htmlFor="password">
          Пароль
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] px-3 py-2 outline-none focus:border-neutral-500"
        />

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="mt-6 w-full rounded-md bg-neutral-900 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? 'Вход…' : 'Войти'}
        </button>
      </form>
    </main>
  )
}
