import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { countRecentClicks, recordClick, getEffectivePlatformLimit, isUserVerified } from '@/lib/db'
import { isProduct, VERIFY_VIDEO_URL, VERIFY_GATE_ENABLED } from '@/lib/config'
import { serveCommentForUrl } from '@/lib/serveComment'

export const dynamic = 'force-dynamic'

// POST { url, platform, search_query } — record that the user opened a link.
// Same as the dashboard: enforces the rolling hourly per-platform cap (returns
// 429 without recording when the platform is at its limit), otherwise records
// the click so the link is removed from the user's list.
export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (VERIFY_GATE_ENABLED && !(await isUserVerified(userId).catch(() => false))) {
    return NextResponse.json(
      { error: 'Comment on the verification video first', verifyRequired: true, verifyUrl: VERIFY_VIDEO_URL },
      { status: 403 }
    )
  }


  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const url = String(b?.url ?? '').trim()
  const platform = String(b?.platform ?? '').trim() || 'unknown'
  const searchQuery = b?.search_query ? String(b.search_query) : null
  // Which product's comment to serve for this link.
  //
  // Normally the SERVER decides, fairly and per link (see serveCommentForUrl),
  // and returns the comment for the app to paste — that keeps the choice and the
  // attribution in one place and lets us balance a link's comment mix.
  //
  // A `product` in the body means an OLDER app build already picked from its own
  // cached pool and pasted that comment; honour it, or we'd record a product the
  // user never actually posted about.
  const rawProduct = String(b?.product ?? '').trim()
  const clientProduct = isProduct(rawProduct) ? rawProduct : null
  if (!url.startsWith('http')) return NextResponse.json({ error: 'Bad url' }, { status: 400 })

  try {
    // Quota enforcement is skipped when THIS platform's own Hourly switch is off
    // — each platform is enforced independently, and there is no master switch.
    const { limit, windowMs, enforced } = await getEffectivePlatformLimit(platform)
    let recent = 0
    if (enforced) {
      recent = await countRecentClicks(userId, platform, windowMs)
      if (limit > 0 && recent >= limit) {
        // Rejected — pick nothing, so a blocked tap doesn't consume a product's
        // turn in this link's rotation.
        return NextResponse.json(
          { error: `Hourly limit reached for ${platform}`, limited: true, platform },
          { status: 429 }
        )
      }
    }

    // Only choose when the client didn't already serve something itself.
    const served = clientProduct
      ? { product: clientProduct, comment: null }
      : await serveCommentForUrl(url).catch(() => ({ product: null, comment: null }))

    await recordClick(userId, url, searchQuery, platform, served.product, served.comment)
    return NextResponse.json({
      ok: true,
      // The app pastes this; absent when an older build already picked its own.
      product: served.product,
      comment: served.comment,
      ...(enforced ? { hourlyCount: recent + 1, limit } : {}),
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
