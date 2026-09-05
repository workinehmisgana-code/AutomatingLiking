import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { isPromoPlatform, PROMO_DAILY_LIMIT_PER_PLATFORM, PROMO_PLATFORMS } from '@/lib/config'
import { countPromoLinksToday, submitPromoLink, getPromoTaskEnabled } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { videoId, platform, url } — record a repost link (earns PROMO_PAY_BIRR).
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

  const platform = String(b?.platform ?? '')
  if (!isPromoPlatform(platform)) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 400 })
  }
  const url = String(b?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Enter a valid link (starting with http).' }, { status: 400 })
  }
  const videoId = b?.videoId != null ? Number(b.videoId) : null

  try {
    const todayCount = await countPromoLinksToday(userId, platform)
    if (todayCount >= PROMO_DAILY_LIMIT_PER_PLATFORM) {
      const label = PROMO_PLATFORMS.find((p) => p.key === platform)?.label ?? platform
      return NextResponse.json(
        { error: `You've already submitted your ${label} upload for today. Try again tomorrow.` },
        { status: 429 }
      )
    }
    await submitPromoLink(userId, {
      videoId: Number.isFinite(videoId as number) ? (videoId as number) : null,
      titleId: null,
      platform,
      url,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
