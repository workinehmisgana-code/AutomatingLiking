import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getUserProfile, isProfileComplete, getBlockForEmail } from '@/lib/db'
import Onboarding from '@/components/Onboarding'
import Login from '@/components/Login'
import Blocked from '@/components/Blocked'
import BlockedRemediation from '@/components/BlockedRemediation'

export const dynamic = 'force-dynamic'

export default async function OnboardingPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />

  // Blocked users can't register/onboard.
  const block = await getBlockForEmail(session.user.email).catch(() => null)
  if (block) {
    if (block.reason === 'forever') return <Blocked email={session.user.email ?? ''} />
    return <BlockedRemediation reason={block.reason} email={session.user.email ?? ''} />
  }

  const profile = await getUserProfile(session.user.id).catch(() => null)
  // Onboarding is just the profile now — users aren't assigned to a product,
  // they work for all of them.
  if (isProfileComplete(profile)) redirect('/')

  return (
    <Onboarding
      initial={profile}
      email={session.user.email ?? ''}
      suggestedName={session.user.name ?? ''}
    />
  )
}
