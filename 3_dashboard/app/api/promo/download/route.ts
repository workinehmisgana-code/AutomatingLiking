import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { PROMO_DOWNLOAD_DAILY_LIMIT } from '@/lib/config'
import {
  recordPromoDownload,
  hasDownloadedVideo,
  countPromoDownloadsToday,
  getPromoDownloadInfo,
  getPromoTaskEnabled,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { videoId } — record a promo download, enforcing the daily download cap.
// Re-downloading a video the user already has is always allowed and free.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  const userId = session?.user?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(userId)
  if (gate) return gate

  if (!(await getPromoTaskEnabled().catch(() => true))) {
    return NextResponse.json({ error: 'The repost task is currently turned off' }, { status: 403 })
  }

  let videoId = 0
  try {
    videoId = Number((await req.json())?.videoId)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Number.isFinite(videoId) || videoId <= 0) {
    return NextResponse.json({ error: 'Bad videoId' }, { status: 400 })
  }

  try {
    const already = await hasDownloadedVideo(userId, videoId)
    if (!already) {
      // A brand-new download counts against the daily quota.
      const todayCount = await countPromoDownloadsToday(userId)
      if (todayCount >= PROMO_DOWNLOAD_DAILY_LIMIT) {
        const { nextResetMs } = await getPromoDownloadInfo(userId)
        return NextResponse.json(
          {
            error: `You've used today's download (${PROMO_DOWNLOAD_DAILY_LIMIT} per day). Come back tomorrow.`,
            nextResetMs,
          },
          { status: 429 }
        )
      }
    }
    await recordPromoDownload(userId, videoId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
