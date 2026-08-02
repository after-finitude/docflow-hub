import { redirect } from 'next/navigation'
import { readSession } from '@/lib/session'
import { LoginForm } from './login-form'

export default async function LoginPage() {
  const session = await readSession()
  // Увести отсюда можно только при действительно живой сессии — проверенной
  // API, а не по факту наличия cookie. При недоступном бэкенде показываем
  // форму: пользователь хотя бы видит осмысленный экран.
  if (session.status === 'authenticated') redirect('/inbox')

  return <LoginForm />
}
