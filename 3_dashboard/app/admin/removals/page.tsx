import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { listRemovals, type RemovalRow } from '@/lib/commentRemoval'
import Login from '@/components/Login'
import RemovalsAdmin from '@/components/RemovalsAdmin'

export const dynamic = 'force-dynamic'

// Admin → Comment removal: which workers must delete their comment on which links.
export default async function RemovalsPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')
  const rows = await listRemovals().catch(() => [] as RemovalRow[])
  return <RemovalsAdmin initial={rows} />
}
