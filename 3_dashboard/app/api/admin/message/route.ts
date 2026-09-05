import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { addAdminMessage, deleteMessageReply, deleteAdminMessage } from '@/lib/db'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// POST { body, userId } — send a message. userId omitted / 'all' → broadcast.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body = ''
  let userId: string | null = null
  try {
    const j = await req.json()
    body = String(j?.body ?? '').trim()
    const uid = j?.userId ? String(j.userId) : ''
    userId = uid && uid !== 'all' ? uid : null
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body) return NextResponse.json({ error: 'Message is empty' }, { status: 400 })

  try {
    await addAdminMessage(userId, body)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// DELETE { replyId } → delete one reply. { messageId } → delete a message (and
// its replies + read receipts).
export async function DELETE(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  try {
    if (b?.replyId != null) {
      const id = Number(b.replyId)
      if (Number.isFinite(id) && id > 0) await deleteMessageReply(id)
    } else if (b?.messageId != null) {
      const id = Number(b.messageId)
      if (Number.isFinite(id) && id > 0) await deleteAdminMessage(id)
    } else {
      return NextResponse.json({ error: 'Nothing to delete' }, { status: 400 })
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
