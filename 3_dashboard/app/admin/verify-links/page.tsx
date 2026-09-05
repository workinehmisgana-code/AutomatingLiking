import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import VerifyLinks from '@/components/VerifyLinks'

export const dynamic = 'force-dynamic'

// Independent "links to verify" staging list (channel-scraped links). Separate
// from the main links pool; verified links are merged into it from here.
export default async function VerifyLinksPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')
  return <VerifyLinks />
}
