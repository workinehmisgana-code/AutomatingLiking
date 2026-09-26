import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getUnreadReplies, markRepliesRead } from '@/lib/db'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

// GET → the messages from users nobody has finished with.
//
// Refetched by the popup after it marks one read, so the count on screen is
// what is in the database rather than what the page remembers.
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    return NextResponse.json({ ok: true, replies: await getUnreadReplies() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST { ids: number[] } → mark those messages as dealt with.
//
// Explicit, and never a side effect of the popup being closed: a message
// dismissed by accident is one nobody answers, and the person who sent it is
// left waiting for a reply that is never coming.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let ids: unknown
  try {
    ids = (await req.json())?.ids
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Array.isArray(ids)) {
    return NextResponse.json({ error: 'ids must be a list' }, { status: 400 })
  }
  try {
    const n = await markRepliesRead(ids.map(Number))
    return NextResponse.json({ ok: true, marked: n, replies: await getUnreadReplies() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
