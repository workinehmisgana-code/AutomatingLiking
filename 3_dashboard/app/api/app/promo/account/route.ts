import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { PROMO_PLATFORMS } from '@/lib/config'
import { savePromoAccounts, getPromoTaskEnabled } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { tiktok?, youtube?, instagram? } — save dedicated repost account links.
export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!(await getPromoTaskEnabled().catch(() => true))) {
    return NextResponse.json({ error: 'The repost task is currently turned off' }, { status: 403 })
  }

  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const accounts = PROMO_PLATFORMS.map((p) => ({ platform: p.key, url: String(b?.[p.key] ?? '').trim() }))
  const provided = accounts.filter((a) => a.url)
  if (provided.length === 0) {
    return NextResponse.json({ error: 'Add at least one dedicated account link.' }, { status: 400 })
  }
  for (const a of provided) {
    if (!/^https?:\/\//i.test(a.url)) {
      const label = PROMO_PLATFORMS.find((p) => p.key === a.platform)?.label ?? a.platform
      return NextResponse.json({ error: `Your ${label} link should start with http(s)://` }, { status: 400 })
    }
  }

  try {
    await savePromoAccounts(userId, provided)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
