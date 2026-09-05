import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { getUnreadMessages, markMessageRead } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET — unread admin messages for the signed-in app user.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const messages = await getUnreadMessages(userId).catch(() => [])
  return NextResponse.json({ messages })
}

// POST { id } — dismiss (mark read) a message when the user closes it.
export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  let id = 0
  try {
    id = Number((await req.json())?.id)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Bad id' }, { status: 400 })
  try {
    await markMessageRead(userId, id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
