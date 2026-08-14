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
    // Форма прижата к левой трети и посажена на 18vh, а не выровнена по
    // центру экрана: у входа нет причин вести себя как афиша.
    <main className="min-h-screen px-6 pt-[18vh] pb-16">
      <div className="mx-auto grid max-w-[1600px] gap-12 md:grid-cols-[minmax(0,22rem)_1fr]">
        <form onSubmit={handleSubmit} noValidate>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-xl font-semibold tracking-tight">Docflow</span>
            <span className="mono text-2xs uppercase tracking-[0.14em] text-muted">hub</span>
          </div>
          <p className="mt-1 text-sm text-muted">Приём, распознавание и проверка документов</p>

          <div className="mt-8 space-y-4">
            <div>
              <label className="label mb-1" htmlFor="login">
                Логин
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
                Пароль
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

          {/* Высота строки сообщения зарезервирована: появление ошибки
              не должно сдвигать кнопку под курсором. */}
          <p
            id="auth-error"
            role={error ? 'alert' : undefined}
            className="mt-3 min-h-[1.25rem] text-xs text-danger"
          >
            {error}
          </p>

          <button type="submit" disabled={pending} className="btn btn--primary mt-2 w-full">
            {pending ? 'Проверяем…' : 'Войти'}
          </button>
        </form>

        <aside className="hidden self-end border-l border-rule pl-12 md:block">
          <p className="max-w-[38ch] text-sm leading-relaxed text-ink-2">
            Каждое извлечённое значение хранит ссылку на область в оригинале, из которой оно взято.
            Система не выдаёт результат, не показывая источник.
          </p>
          <dl className="mt-8 grid max-w-md grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-xs">
            <dt className="text-muted">Типы документов</dt>
            <dd className="mono">инвойс · выписка · письмо · договор</dd>
            <dt className="text-muted">Источники</dt>
            <dd className="mono">загрузка · папка · Диск</dd>
            <dt className="text-muted">Проверка</dt>
            <dd className="mono">правила схемы + уверенность полей</dd>
          </dl>
        </aside>
      </div>
    </main>
  )
}
