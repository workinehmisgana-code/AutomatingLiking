import type { NextRequest } from 'next/server'
import { getUserIdByAppToken } from './db'
import { hasCompleteProfile, isTiktokVerified } from './profileGate'
import { VERIFY_GATE_ENABLED } from './config'

// Resolve the native app's bearer token (or ?token=) to a dashboard user id.
//
// A token whose owner has not finished onboarding resolves to null, so every
// app route answers 401 — which the bubble treats as "sign in again", sending
// the user to /app-login, where the token route explains what is missing. That
// keeps a field APK we cannot rebuild on a sane path.
//
// THE SAME APPLIES TO THE ACCOUNT-AGE GATE. An unverified worker — or one whose
// TikTok account came back younger than the minimum — must not be served links
// by the app either, and the app's feed is a different code path from the web
// dashboard's. Putting the check HERE rather than in each route is what makes
// that true for every one of them, including any added later: there is one door
// and the gate is on it.
//
// The 401 lands on the same explaining path as an incomplete profile, because
// /api/app/token runs profileGate, which answers with the reason.
export async function userIdFromApp(req: NextRequest): Promise<string | null> {
  const header = req.headers.get('authorization') || ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  const token = (m ? m[1] : req.nextUrl.searchParams.get('token') || '').trim()
  if (!token) return null
  const userId = await getUserIdByAppToken(token)
  if (!userId) return null
  if (!(await hasCompleteProfile(userId).catch(() => false))) return null
  // Fail CLOSED on an error: isTiktokVerified answering false because the
  // database hiccuped holds somebody for a minute, which is recoverable. The
  // other way round serves links to an account we have not checked, which is
  // the thing the gate exists to stop.
  if (VERIFY_GATE_ENABLED && !(await isTiktokVerified(userId).catch(() => false))) return null
  return userId
}
