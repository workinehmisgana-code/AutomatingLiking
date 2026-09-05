import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { addUnrelatedLink, removeUserClick } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { url, platform } — flag a link as unrelated to humanizers. This hides it
// from this user but does NOT count toward the click/retire quota.
export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let url = ''
  let platform = ''
  try {
    const b = await req.json()
    url = String(b?.url ?? '').trim()
    platform = String(b?.platform ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!/^https?:\/\//.test(url)) return NextResponse.json({ error: 'Invalid url' }, { status: 400 })

  try {
    await addUnrelatedLink(userId, url, platform || null)
    // The user opened this link (via Next) before flagging it — drop that click
    // so an unrelated video never counts toward the quota.
    await removeUserClick(userId, url).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
