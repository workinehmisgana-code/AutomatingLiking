import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import {
  resetAllData,
  resetUserData,
  restoreGlobalReset,
  restoreUserReset,
} from '@/lib/db'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// POST {}                              → reset all users; returns undo descriptor
// POST { userId }                      → reset one user; returns undo descriptor
// POST { action:'restore', scope, userId?, prevIso } → undo a reset (restores the
//   reset window; deleted screenshots are NOT restored)
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let body: Record<string, unknown> = {}
  try {
    body = await req.json().catch(() => ({}))
  } catch {
    body = {}
  }

  try {
    if (body?.action === 'restore') {
      const prevIso = body?.prevIso != null ? String(body.prevIso) : null
      if (body?.scope === 'all') {
        await restoreGlobalReset(prevIso ?? new Date(0).toISOString())
      } else {
        await restoreUserReset(String(body?.userId ?? ''), prevIso)
      }
      return NextResponse.json({ ok: true })
    }

    const userId = body?.userId ? String(body.userId) : null
    if (userId) {
      const prevIso = await resetUserData(userId)
      return NextResponse.json({ ok: true, undo: { scope: 'user', userId, prevIso } })
    }
    const prevIso = await resetAllData()
    return NextResponse.json({ ok: true, undo: { scope: 'all', prevIso } })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
