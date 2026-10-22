import { NextResponse } from 'next/server'
import { getUserProfile, isProfileComplete, getTiktokVerification, getMinAccountAgeDays, isTestUser } from './db'
import { VERIFY_GATE_ENABLED, VERIFY_MIN_AGE_DAYS } from './config'
import { handleOf } from './tiktokVerify'

// A profile is only usable if we can PAY the person (bank account), VERIFY them
// (TikTok handle) and REACH them (a phone number or a Telegram username).
// Without all three, work they do is unpayable, their comment presence can
// never be checked, and nobody can tell them about either — so the earning
// surfaces are closed until onboarding is finished. See isProfileComplete() in
// lib/db.ts.
export const PROFILE_REQUIRED_MESSAGE =
  'Add your bank account number and bank, TikTok profile link, and a phone number or ' +
  'Telegram username on the dashboard before you can work.'

export const VERIFY_REQUIRED_MESSAGE =
  'Verify your TikTok account before you can work: comment your name on the ' +
  'video shown on the dashboard, then press Check.'

export async function hasCompleteProfile(userId: string): Promise<boolean> {
  const profile = await getUserProfile(userId).catch(() => null)
  return isProfileComplete(profile)
}

/**
 * Has this worker proved they own a TikTok account at least three months old?
 *
 * EVERYONE, not just new sign-ups. The rule is about the account doing the
 * commenting, and an account that was never checked is not older for having
 * gone unasked — so existing workers are held the same way until they have
 * done it once.
 *
 * TIED TO THE HANDLE, which is what makes "once, permanently" safe. The verdict
 * is about one specific account; change the TikTok link on the profile and the
 * stored verdict no longer describes the account being used, so it stops
 * counting and the check has to be done again for the new one. Without that
 * tie, verifying an old account once and then switching the link would be the
 * whole bypass.
 */
export async function isTiktokVerified(userId: string): Promise<boolean> {
  // The owner's test accounts are never held by the account-age gate.
  if (await isTestUser(userId).catch(() => false)) return true
  const [v, profile, minAgeDays] = await Promise.all([
    getTiktokVerification(userId).catch(() => null),
    getUserProfile(userId).catch(() => null),
    getMinAccountAgeDays().catch(() => VERIFY_MIN_AGE_DAYS),
  ])
  const now = handleOf(profile?.tiktok_url ?? '')
  // A verdict with no handle on it predates the tie and cannot be trusted to
  // describe the account in use.
  if (!v || !v.handle || !now || v.handle !== now) return false
  return verifiedNow(v, minAgeDays)
}

/**
 * Does a stored verdict pass TODAY's minimum account age?
 *
 * AGAINST THE CURRENT SETTING, NOT THE ONE AT CHECK TIME. A verdict used to be
 * final, so an account that passed while the minimum was briefly lower — two
 * did, at 4 and 6 days old — stayed verified for good under a 90-day rule. The
 * account's creation date is stored with the verdict, so its age is simply
 * recomputed: everyone, however long they have worked here, needs an account
 * older than the minimum in force now.
 *
 * Both ways round: a 'too_new' account that has since aged past the minimum
 * passes without commenting again — it already proved it is theirs. A verdict
 * with no creation date (written before dates were stored) keeps its status.
 */
export function verifiedNow(
  v: { status: string; accountAt: string | null },
  minAgeDays: number,
  at: Date = new Date()
): boolean {
  if (v.status !== 'ok' && v.status !== 'too_new') return false
  const created = v.accountAt ? Date.parse(v.accountAt) : NaN
  if (!Number.isFinite(created)) return v.status === 'ok'
  return (at.getTime() - created) / 86_400_000 >= minAgeDays
}

/**
 * Guard for session-authed earning routes.
 *
 * Returns a 403 response to send straight back, or null when the request may
 * proceed. The flags let a client tell the cases apart and send the person to
 * the right place rather than to a generic error.
 */
export async function profileGate(userId: string): Promise<NextResponse | null> {
  if (!(await hasCompleteProfile(userId))) {
    return NextResponse.json(
      { error: PROFILE_REQUIRED_MESSAGE, needsProfile: true },
      { status: 403 }
    )
  }
  // Behind the same switch as the on-screen gate, so one setting governs both
  // and the two can never disagree about whether the rule is in force.
  if (VERIFY_GATE_ENABLED && !(await isTiktokVerified(userId))) {
    return NextResponse.json(
      { error: VERIFY_REQUIRED_MESSAGE, needsTiktokVerify: true },
      { status: 403 }
    )
  }
  return null
}
