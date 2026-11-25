import { NextResponse, type NextRequest } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { checkRemoval } from '@/lib/commentRemoval'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { id } — "I removed it": read the video and cross the link off if it is gone.
export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const b = (await req.json().catch(() => ({}))) as { id?: unknown }
  const id = Number(b.id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Bad id' }, { status: 400 })
  try {
    const r = await checkRemoval(userId, id)
    if (!r) return NextResponse.json({ error: 'Not on your list' }, { status: 404 })
    return NextResponse.json({ ok: true, ...r })
  } catch (e) {
    return NextResponse.json({ error: `Could not check: ${String(e)}` }, { status: 502 })
  }
}
