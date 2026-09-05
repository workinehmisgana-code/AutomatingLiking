import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { addMessageReply } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { messageId, body } — the signed-in user replies to an admin message.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  const userId = session?.user?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let messageId = 0
  let body = ''
  try {
    const j = await req.json()
    messageId = Number(j?.messageId)
    body = String(j?.body ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Number.isFinite(messageId) || messageId <= 0) {
    return NextResponse.json({ error: 'Invalid messageId' }, { status: 400 })
  }
  if (!body) return NextResponse.json({ error: 'Reply is empty' }, { status: 400 })

  try {
    const ok = await addMessageReply(userId, messageId, body)
    if (!ok) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
