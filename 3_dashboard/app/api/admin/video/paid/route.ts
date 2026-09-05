import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { setVideoPaid } from '@/lib/db'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// POST { id, paid } — mark a video submission paid/unpaid (admin only).
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let id = 0
  let paid = false
  try {
    const body = await req.json()
    id = Number(body?.id)
    paid = Boolean(body?.paid)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    await setVideoPaid(id, paid)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
