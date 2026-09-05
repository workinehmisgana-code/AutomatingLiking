import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { loadVideosJson } from '@/lib/videos'
import { saveLinkStats, countLinkStats } from '@/lib/db'
import { fetchStats, tiktokVideoId } from '@/lib/linkStats'
import { parsePostedDate } from '@/lib/cluster'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Refresh live like/view counts from TikTok's embed page.
//
// One request cannot do ~89k links, so this is BATCHED: the client posts an
// offset, the route works until its own deadline, and returns where to resume.
// The client loops and draws the progress bar. Nothing is held server-side
// between batches beyond the rows already written, so a closed tab just stops
// the run — reopening it resumes from what is already in link_stat.
//
// Counts land in link_stat rather than videos.json: a batch is then a few
// upserts instead of rewriting a 24 MB blob 200+ times.

/** Stop fetching here and return, leaving room to write rows and respond. */
const BUDGET_MS = 40_000
const CONCURRENCY = 8
/** Cap per request, so one batch can't run unboundedly if TikTok is fast. */
const MAX_BATCH = 600

/**
 * Only refresh posts younger than this by default.
 *
 * A month-old post's like count has essentially settled, while a post from this
 * week is still climbing — so the recent slice is where a stale number actually
 * misprices a link. It is also the difference between a ~37 minute pass over
 * ~22k links and a ~3 hour pass over ~89k.
 */
const DEFAULT_MAX_AGE_DAYS = 30

/**
 * Pool URLs this endpoint can refresh, in a stable order.
 *
 * `maxAgeDays` of 0 means no age limit. Links whose posted date we cannot parse
 * are always included: we can't rule them out as old, and there are few enough
 * of them that checking is cheaper than reasoning about it.
 */
async function refreshableUrls(maxAgeDays: number): Promise<string[]> {
  const videos = await loadVideosJson().catch(() => [])
  const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : null
  const urls: string[] = []
  for (const v of videos) {
    const url = String(v.url ?? '')
    // The embed page is TikTok-only; YouTube and Instagram links are skipped.
    if (!tiktokVideoId(url)) continue
    if (cutoff !== null) {
      const t = parsePostedDate(
        v.posted_date == null ? undefined : String(v.posted_date),
        v.scraped_at == null ? undefined : String(v.scraped_at)
      )
      if (t !== null && t < cutoff) continue
    }
    urls.push(url)
  }
  // Sorted so the offset means the same thing across requests even as the pool
  // grows — an appended link can't shift everything after it into a re-fetch.
  urls.sort()
  return urls
}

/** Age window from the request, clamped; 0 = every link. */
function ageOf(v: unknown): number {
  if (v === 'all' || v === 0 || v === '0') return 0
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(3650, Math.floor(n)) : DEFAULT_MAX_AGE_DAYS
}

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const days = ageOf(req.nextUrl.searchParams.get('days'))
  const [urls, refreshed] = await Promise.all([
    refreshableUrls(days),
    countLinkStats().catch(() => 0),
  ])
  return NextResponse.json({ total: urls.length, refreshed, days })
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    offset?: unknown
    limit?: unknown
    days?: unknown
  }
  const offset = Math.max(0, Number(body.offset) || 0)
  const limit = Math.min(MAX_BATCH, Math.max(1, Number(body.limit) || MAX_BATCH))
  const days = ageOf(body.days)

  const urls = await refreshableUrls(days)
  const total = urls.length
  if (offset >= total) {
    return NextResponse.json({ ok: true, total, days, nextOffset: total, processed: 0, updated: 0, failed: 0, done: true })
  }

  const slice = urls.slice(offset, offset + limit)
  const { stats, consumed } = await fetchStats(slice, CONCURRENCY, Date.now() + BUDGET_MS)

  // A null pair means the fetch failed (removed video, rate limit, timeout).
  // Those rows are not written, so the stored value stays whatever it was.
  // isPhoto counts as a result on its own: a photo post with 0 likes and 0 views
  // still tells us what kind of post it is.
  const ok = stats.filter((s) => s.hearts !== null || s.views !== null || s.isPhoto !== null)
  let updated = 0
  try {
    updated = await saveLinkStats(ok)
  } catch (e) {
    return NextResponse.json({ error: `Could not save counts: ${String(e)}` }, { status: 500 })
  }

  // Advance past everything actually attempted. `consumed` (not stats.length)
  // is what the workers reached before the deadline — advancing by the number of
  // successes would re-fetch failures forever.
  const nextOffset = offset + Math.max(consumed, stats.length)
  return NextResponse.json({
    ok: true,
    total,
    days,
    nextOffset,
    processed: stats.length,
    updated,
    failed: stats.length - ok.length,
    done: nextOffset >= total,
  })
}
