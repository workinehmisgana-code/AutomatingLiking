import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getAdminGenre } from '@/lib/adminGenre'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import LikerSettings from '@/components/LikerSettings'

export const dynamic = 'force-dynamic'

/**
 * What the phone's comment liker does, set from here.
 *
 * The phone holds no settings of its own: it asks `/api/app/liker` on every
 * start, so a change made here is the one the next run uses. That is the point
 * of putting them on the dashboard rather than in the app — a handset in
 * somebody's pocket is the worst place to keep a number you want to change.
 */
export const metadata = {
  title: 'Phone liker',
}

export default async function AdminLikerPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')
  return <LikerSettings genre={await getAdminGenre()} />
}
