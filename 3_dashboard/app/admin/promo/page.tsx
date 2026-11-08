import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getAdminGenreScope } from '@/lib/adminGenre'
import { getPromoAdminData } from '@/lib/db'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import PromoAdmin from '@/components/PromoAdmin'
import PickGenreNote from '@/components/PickGenreNote'

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

  // ONE GENRE: promo offers one genre's products. In the switch's All it asks
  // for one rather than quietly showing the default's.
  const genre = await getAdminGenreScope()
  if (!genre) return <PickGenreNote what="Promo review" />
  const videos = await getPromoAdminData().catch(() => [])
  return <PromoAdmin videos={videos} genre={genre} />
}
