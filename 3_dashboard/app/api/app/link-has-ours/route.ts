import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { saveLinkScan } from '@/lib/db'
import { scanLink } from '@/lib/commentScan'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { url } — does this video carry a comment naming one of our products
// RIGHT NOW? The Comment Tester asks this in the background for the next few
// links, so it only ever opens a video with none of ours on it.
//
// A fresh read of the comment list, not the stored scan: the stored one can be
// days old, and a link that was clean last week may have one of ours today. The
// read is saved like any other extraction, so what the tester learns also keeps
// those links out of everyone else's "only links with none of ours" lists.
export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { url?: unknown }
  const url = String(body.url ?? '').trim()
  if (!/tiktok\.com\//i.test(url)) {
    // Only TikTok comment lists can be read here; anything else is "unknown",
    // and the app treats unknown as usable rather than hiding the link.
    return NextResponse.json({ ok: true, ours: false, readable: false })
  }
  try {
    const res = await scanLink(url)
    if (!res.unresolved) {
      await saveLinkScan({
        url: res.url,
        readCount: res.readCount,
        totalCount: res.totalCount,
        complete: res.complete,
        ourCount: res.ourCount,
        bestRank: res.bestRank,
        topText: res.top?.text ?? null,
        topUser: res.top?.username ?? null,
        topLikes: res.top?.likes ?? null,
        hits: res.hits,
      }).catch(() => {})
    }
    return NextResponse.json({
      ok: true,
      ours: res.ourCount > 0,
      count: res.ourCount,
      products: Array.from(new Set(res.hits.map((h) => h.product))),
      // false when the comments could not be read at all; the app then treats
      // the link as usable instead of throwing away one it knows nothing about.
      readable: !res.unresolved,
    })
  } catch (e) {
    return NextResponse.json({ ok: true, ours: false, readable: false, error: String(e) })
  }
}
