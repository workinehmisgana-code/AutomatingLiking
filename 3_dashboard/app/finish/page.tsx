import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getBlockForEmail, getUserProfile, isProfileComplete } from '@/lib/db'
import { redirect } from 'next/navigation'
import Login from '@/components/Login'
import Blocked from '@/components/Blocked'
import BlockedRemediation from '@/components/BlockedRemediation'
import FinishForm from '@/components/FinishForm'

export const dynamic = 'force-dynamic'

// Standalone Finish page — the Android bubble opens this in the browser so the
// screenshot uploads work with a real file picker.
export default async function FinishPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  const block = await getBlockForEmail(session.user.email).catch(() => null)
  if (block) {
    if (block.reason === 'forever') return <Blocked email={session.user.email ?? ''} />
    return <BlockedRemediation reason={block.reason} email={session.user.email ?? ''} />
  }
  // Reporting work is an earning surface, so it needs a payable, verifiable
  // profile — this page is opened directly by the bubble and so never passes
  // through the onboarding redirect on the dashboard home page.
  const profile = await getUserProfile(session.user.id).catch(() => null)
  if (!isProfileComplete(profile)) redirect('/onboarding')
  return <FinishForm />
}
