import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getPromoAdminData } from '@/lib/db'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import PromoAdmin from '@/components/PromoAdmin'

export const dynamic = 'force-dynamic'

export default async function AdminPromoPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')

  const videos = await getPromoAdminData().catch(() => [])
  return <PromoAdmin videos={videos} />
}
