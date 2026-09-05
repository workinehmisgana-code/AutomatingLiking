import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { setPromoTaskEnabled } from '@/lib/db'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// POST { enabled } — turn the repost ("Repost & earn") task on/off for all users.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let enabled = true
  try {
    const body = await req.json()
    enabled = Boolean(body?.enabled)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  try {
    await setPromoTaskEnabled(enabled)
    return NextResponse.json({ ok: true, enabled })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
