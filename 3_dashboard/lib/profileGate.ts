import { NextResponse } from 'next/server'
import { getUserProfile, isProfileComplete } from './db'

// A profile is only usable if we can PAY the person (bank account), VERIFY them
// (TikTok handle) and REACH them (a phone number or a Telegram username).
// Without all three, work they do is unpayable, their comment presence can
// never be checked, and nobody can tell them about either — so the earning
// surfaces are closed until onboarding is finished. See isProfileComplete() in
// lib/db.ts.
export const PROFILE_REQUIRED_MESSAGE =
  'Add your bank account number, TikTok profile link, and a phone number or ' +
  'Telegram username on the dashboard before you can work.'

export async function hasCompleteProfile(userId: string): Promise<boolean> {
  const profile = await getUserProfile(userId).catch(() => null)
  return isProfileComplete(profile)
}

/**
 * Guard for session-authed earning routes.
 *
 * Returns a 403 response to send straight back, or null when the profile is
 * complete and the request may proceed. `needsProfile` lets a client tell this
 * apart from a block or a sign-in problem and point the user at /onboarding.
 */
export async function profileGate(userId: string): Promise<NextResponse | null> {
  if (await hasCompleteProfile(userId)) return null
  return NextResponse.json(
    { error: PROFILE_REQUIRED_MESSAGE, needsProfile: true },
    { status: 403 }
  )
}
