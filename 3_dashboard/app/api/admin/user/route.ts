import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { deleteUser, getUserNameEmail, blockUser, unblockUser, isBlockReason } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// DELETE — permanently remove a user and all of their data. { userId }
export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let userId = ''
  try {
    userId = String((await req.json())?.userId ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })

  // Safety: never delete an admin account.
  const info = await getUserNameEmail(userId).catch(() => null)
  if (info && isAdminEmail(info.email)) {
    return NextResponse.json({ error: 'Cannot delete an admin account.' }, { status: 400 })
  }

  try {
    await deleteUser(userId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST { userId, action: 'block' | 'unblock', reason? } — block a user from
// signing in and re-registering, or lift it. `reason` (required for 'block') is
// 'bank' (incorrect bank account), 'tiktok' (visibility restricted), or 'forever'.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let userId = ''
  let action = ''
  let reason = ''
  try {
    const b = await req.json()
    userId = String(b?.userId ?? '').trim()
    action = String(b?.action ?? '').trim()
    reason = String(b?.reason ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
  if (action !== 'block' && action !== 'unblock') {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
  if (action === 'block' && !isBlockReason(reason)) {
    return NextResponse.json({ error: 'Invalid block reason' }, { status: 400 })
  }

  // Safety: never block an admin account.
  const info = await getUserNameEmail(userId).catch(() => null)
  if (info && isAdminEmail(info.email)) {
    return NextResponse.json({ error: 'Cannot block an admin account.' }, { status: 400 })
  }

  try {
    if (action === 'block') await blockUser(userId, reason as 'bank' | 'tiktok' | 'forever')
    else await unblockUser(userId)
    return NextResponse.json({ ok: true, blocked: action === 'block' })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
