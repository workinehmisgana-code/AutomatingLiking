import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getAdminGenre, adminGenreUrlTest } from '@/lib/adminGenre'
import { isAdminEmail } from '@/lib/config'
import { buildAdminLinks, filterAdminLinks, parseLinkQuery } from '@/lib/adminLinks'
import {
  getUrlsMissingCommentDates,
  countMissingCommentDates,
  saveLinkScan,
} from '@/lib/db'
import { scanLink } from '@/lib/commentScan'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Fill in the posting dates we never kept.
//
// Every comment row written before the extract learned to read `create_time` has
// no date, and a windowed view cannot place it in time — so it is held out of one
// rather than judged by when its link was last scanned, which is how a comment
// from 18 August once appeared inside a 7-day view.
//
// THE FIX IS THE SAME EXTRACT, AIMED. Re-reading a link rewrites its comment rows
// and now stores the date TikTok gives for each one, so nothing here is a repair
// of bad data: it is the ordinary scan, pointed at exactly the links that would
// gain from it, oldest scan first. Those links are also the most stale, so the
// pass refreshes their comment counts on the way past.
//
// Resumable and bounded like the other readers: a deadline, a batch, and a count
// of what is left, so the page can keep calling until nothing is.

const BUDGET_MS = 45_000
/** Comment reads in flight. Same ceiling as the scan and the presence sweep. */
const CONCURRENCY = 4

/**
 * The links this request covers: the page's filter, or everywhere.
 *
 * Shared by both handlers so the bar's denominator and the work it measures are
 * the same set — a total counted over one scope and progress over another is a
 * bar that never reaches the end.
 */
async function scopeUrls(sp: URLSearchParams): Promise<string[] | undefined> {
  // ALWAYS ONE GENRE. "Everywhere" means every link of the genre the switch
  // is on, so a website session never fills dates on humanizer links.
  const genre = await getAdminGenre()
  if (sp.get('scope') === 'all') {
    const { rows, retirePlatforms } = await buildAdminLinks('')
    return filterAdminLinks(rows, { ...parseLinkQuery(new URLSearchParams()), genre }, retirePlatforms).map((l) => l.url)
  }
  const qy = { ...parseLinkQuery(sp), genre }
  const narrowed =
    (qy.clusters?.length ?? 0) > 0 ||
    !!qy.platform ||
    !!qy.product ||
    !!qy.keyword ||
    !!qy.q ||
    !!qy.uploadDate ||
    !!qy.titleFilter ||
    !!qy.mediaFilter
  if (!narrowed) {
    const { rows, retirePlatforms } = await buildAdminLinks('')
    return filterAdminLinks(rows, { ...parseLinkQuery(new URLSearchParams()), genre }, retirePlatforms).map((l) => l.url)
  }
  const { rows, retirePlatforms } = await buildAdminLinks(qy.product ?? '')
  return filterAdminLinks(rows, qy, retirePlatforms).map((l) => l.url)
}

/** GET — how much there is to do, so the bar can start at a known length. */
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const urls = await scopeUrls(req.nextUrl.searchParams)
  if (urls && urls.length === 0) {
    return NextResponse.json({ ok: true, rows: 0, links: 0 })
  }
  const left = await countMissingCommentDates(urls ?? []).catch(() => ({ rows: 0, links: 0 }))
  return NextResponse.json({ ok: true, ...left })
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const urls = await scopeUrls(sp)
  if (urls && urls.length === 0) {
    return NextResponse.json({ ok: true, scanned: 0, rows: 0, links: 0, remaining: 0, done: true })
  }

  try {
    const batch = await getUrlsMissingCommentDates({ urls, limit: 120 })
    if (batch.length === 0) {
      const left = await countMissingCommentDates(urls ?? [])
      return NextResponse.json({ ok: true, scanned: 0, ...left, remaining: 0, done: true })
    }

    const deadline = Date.now() + BUDGET_MS
    let scanned = 0
    let next = 0
    const worker = async () => {
      for (;;) {
        // At least one link always runs, or a caller with no time left would
        // loop forever making no progress.
        if (scanned > 0 && Date.now() >= deadline) return
        const i = next++
        if (i >= batch.length) return
        const res = await scanLink(batch[i]).catch(() => null)
        if (!res) continue
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
        scanned++
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker)
    )

    const left = await countMissingCommentDates(urls ?? [])
    return NextResponse.json({
      ok: true,
      scanned,
      ...left,
      remaining: left.links,
      done: left.links === 0,
    })
  } catch (e) {
    return NextResponse.json(
      { error: `Could not fill the dates: ${String(e)}` },
      { status: 500 }
    )
  }
}
