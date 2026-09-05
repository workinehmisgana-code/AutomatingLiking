import type { NextRequest } from 'next/server'
import { getUserIdByAppToken } from './db'
import { hasCompleteProfile } from './profileGate'

// Resolve the native app's bearer token (or ?token=) to a dashboard user id.
//
// A token whose owner has not finished onboarding resolves to null, so every
// app route answers 401 — which the bubble treats as "sign in again", sending
// the user to /app-login, where the token route explains what is missing. That
// keeps a field APK we cannot rebuild on a sane path.
export async function userIdFromApp(req: NextRequest): Promise<string | null> {
  const header = req.headers.get('authorization') || ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  const token = (m ? m[1] : req.nextUrl.searchParams.get('token') || '').trim()
  if (!token) return null
  const userId = await getUserIdByAppToken(token)
  if (!userId) return null
  if (!(await hasCompleteProfile(userId).catch(() => false))) return null
  return userId
}
