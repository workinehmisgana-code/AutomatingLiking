import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import AdminReplies from '@/components/AdminReplies'

export const dynamic = 'force-dynamic'

// Thin shell — the drafts are paged in from /api/admin/replies, so nothing large
// is serialised into the RSC payload.
export default async function AdminRepliesPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')
  return <AdminReplies />
}
