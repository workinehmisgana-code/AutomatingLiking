import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { isPromoPlatform, PROMO_DAILY_LIMIT_PER_PLATFORM, PROMO_PLATFORMS } from '@/lib/config'
import { countPromoLinksToday, submitPromoLink, getPromoTaskEnabled } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { videoId, titleId, platform, url } — record a repost link. Enforces the
// per-platform daily limit and earns the user PROMO_PAY_BIRR.
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

  const platform = String(b?.platform ?? '')
  if (!isPromoPlatform(platform)) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 400 })
  }
  const url = String(b?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'Enter a valid link (starting with http).' }, { status: 400 })
  }
  const videoId = b?.videoId != null ? Number(b.videoId) : null
  const titleId = b?.titleId != null ? Number(b.titleId) : null

  try {
    const todayCount = await countPromoLinksToday(userId, platform)
    if (todayCount >= PROMO_DAILY_LIMIT_PER_PLATFORM) {
      const label = PROMO_PLATFORMS.find((p) => p.key === platform)?.label ?? platform
      return NextResponse.json(
        {
          error: `You've already submitted your ${label} upload for today. You can post at most ${PROMO_DAILY_LIMIT_PER_PLATFORM} video per day on each account — try again tomorrow.`,
        },
        { status: 429 }
      )
    }
    await submitPromoLink(userId, {
      videoId: Number.isFinite(videoId as number) ? (videoId as number) : null,
      titleId: Number.isFinite(titleId as number) ? (titleId as number) : null,
      platform,
      url,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
