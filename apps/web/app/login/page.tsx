import { redirect } from 'next/navigation'
import { readSession } from '@/lib/session'
import { LoginForm } from './login-form'

export default async function LoginPage() {
  const session = await readSession()
  // Redirect only for a live session verified by the API, not merely because
  // a cookie exists. Show the form when the backend is unavailable.
  if (session.status === 'authenticated') redirect('/inbox')

  return <LoginForm />
}
