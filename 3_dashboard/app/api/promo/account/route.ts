import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { PROMO_PLATFORMS } from '@/lib/config'
import { savePromoAccounts, getPromoTaskEnabled } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { tiktok?, youtube?, instagram? } — save the user's dedicated repost
// account links. At least one is required.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  const userId = session?.user?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(userId)
  if (gate) return gate

  if (!(await getPromoTaskEnabled().catch(() => true))) {
    return NextResponse.json({ error: 'The repost task is currently turned off' }, { status: 403 })
  }

  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const accounts = PROMO_PLATFORMS.map((p) => ({
    platform: p.key,
    url: String(b?.[p.key] ?? '').trim(),
  }))
  const provided = accounts.filter((a) => a.url)
  if (provided.length === 0) {
    return NextResponse.json({ error: 'Add at least one dedicated account link.' }, { status: 400 })
  }
  // Basic URL sanity check on the ones provided.
  for (const a of provided) {
    if (!/^https?:\/\//i.test(a.url)) {
      const label = PROMO_PLATFORMS.find((p) => p.key === a.platform)?.label ?? a.platform
      return NextResponse.json(
        { error: `Your ${label} link should start with http(s)://` },
        { status: 400 }
      )
    }
  }

  try {
    await savePromoAccounts(userId, provided)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
