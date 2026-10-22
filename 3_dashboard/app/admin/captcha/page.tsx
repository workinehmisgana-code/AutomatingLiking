import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import RemoteCaptcha from '@/components/RemoteCaptcha'

export const dynamic = 'force-dynamic'

/**
 * Solve the liker's captchas from a phone.
 *
 * Nothing is fetched here: the page is opened and left open, and the component
 * polls. A server render would hand the phone one snapshot of a table that
 * changes the moment an account gets stuck, which is the opposite of useful.
 */
export const metadata = {
  title: 'Captcha',
}

export default async function AdminCaptchaPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')
  return <RemoteCaptcha />
}
