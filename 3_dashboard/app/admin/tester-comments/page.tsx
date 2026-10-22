import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getTesterComments } from '@/lib/testerComments'
import Login from '@/components/Login'
import TesterCommentsAdmin from '@/components/TesterCommentsAdmin'

export const dynamic = 'force-dynamic'

// Admin → Tester comments: the list the Comment Tester app shows under 💬.
export default async function TesterCommentsPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')

  const comments = await getTesterComments().catch(() => [] as string[])
  return <TesterCommentsAdmin initial={comments} />
}
