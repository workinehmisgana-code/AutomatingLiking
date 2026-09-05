import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import {
  isAdminEmail,
  RETIRE_AFTER_USERS,
  INSTAGRAM_RETIRE_AFTER_USERS,
  RANK_CLUSTER_COUNT,
  DATE_CLUSTER_COUNT,
} from '@/lib/config'
import Login from '@/components/Login'
import AdminLinks from '@/components/AdminLinks'

export const dynamic = 'force-dynamic'

// Thin shell. The rows, the filters and the pool-wide counts all come from
// /api/admin/links/list — this page used to serialise the entire pool into the
// RSC payload (~26 MB at 82k links) just to render a hundred rows.
export default async function AdminLinksPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')

  return (
    <AdminLinks
      retireCap={RETIRE_AFTER_USERS}
      instagramRetire={INSTAGRAM_RETIRE_AFTER_USERS}
      clusterCount={Math.max(RANK_CLUSTER_COUNT, DATE_CLUSTER_COUNT)}
    />
  )
}
