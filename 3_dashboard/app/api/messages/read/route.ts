import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { markMessageRead } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { id } — the signed-in user dismisses a message.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  const userId = session?.user?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let id = 0
  try {
    const j = await req.json()
    id = Number(j?.id)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    await markMessageRead(userId, id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
