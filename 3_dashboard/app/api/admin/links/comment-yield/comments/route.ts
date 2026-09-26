import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getLinkScans,
  getProductCommentsForUrls,
  type LinkScanRow,
  type OurComment,
} from '@/lib/db'
import { fetchComments } from '@/lib/linkStats'
import { productsIn } from '@/lib/commentScan'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Links per request. One channel's worth, with room to spare. */
const MAX_URLS = 300

/** Comment pages per link (50 each) — the same depth the scan reads. */
const MAX_PAGES = 4

/**
 * Reads in flight at once, and when to stop starting new ones.
 *
 * Both lifted from lib/commentPresence, which does the same job against the same
 * endpoint: TikTok answers in 1–5s and occasionally 19, so concurrency is what
 * makes reading a whole channel feasible, and a deadline is what stops the
 * request dying at the platform's 60s limit with nothing to show for it.
 */
const CONCURRENCY = 4
const DEADLINE_MS = 45_000

/**
 * What is actually written under a set of links.
 *
 * POST { urls: string[], full?: boolean }
 *
 * Separate from the yield table on purpose. The table covers every channel at
 * once and only needs counts; comment TEXT is wanted for one channel at a time,
 * the moment its row is opened, and shipping all of it with the table would put
 * megabytes of other people's comments into a response nobody had asked for.
 *
 * TWO MODES, because they cost very different things:
 *
 *   stored (default)  what the last extraction WROTE DOWN: our product comments
 *                     verbatim, and the video's own top comment. No network, so
 *                     it is instant and can be done on every row opened.
 *
 *   full              every comment on the video, read from TikTok right now.
 *                     One request per page per link, so a 40-link channel is
 *                     ~40–160 requests: opt-in, never automatic. Bounded by a
 *                     deadline and RESUMABLE — the links it reached come back,
 *                     the rest simply are not in the response, and the caller
 *                     asks again for what is missing. A partial answer beats a
 *                     timeout that returns nothing.
 *
 * The live list is not written to link_comment_scan. It is a look at the video
 * as it is now, taken to answer a question on screen; the scan is a measurement
 * the whole pipeline depends on, and a read taken for a different purpose, at a
 * different depth, has no business overwriting it.
 */
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const body = await req.json().catch(() => ({}))
    const urls = (
      Array.isArray(body?.urls)
        ? Array.from(new Set(body.urls.filter((u: unknown) => typeof u === 'string' && u)))
        : []
    ).slice(0, MAX_URLS) as string[]
    if (urls.length === 0) return NextResponse.json({ links: {}, remaining: 0 })

    const [scans, ours] = await Promise.all([
      getLinkScans(urls).catch(() => ({}) as Record<string, LinkScanRow>),
      getProductCommentsForUrls(urls).catch(() => ({}) as Record<string, OurComment[]>),
    ])

    // ── the live read, when asked for ────────────────────────────────────────
    const live = new Map<string, unknown>()
    if (body?.full === true) {
      const deadline = Date.now() + DEADLINE_MS
      let next = 0
      const worker = async () => {
        for (;;) {
          // At least one link always runs, or a caller with no time left would
          // make no progress and loop forever asking for the same thing.
          if (live.size > 0 && Date.now() >= deadline) return
          const i = next++
          if (i >= urls.length) return
          const url = urls[i]
          try {
            const read = await fetchComments(url, MAX_PAGES)
            live.set(url, {
              comments: read.comments.map((c, rank) => ({
                rank,
                username: c.username,
                text: c.text,
                likes: c.likes,
                // Marked by the SAME rule the scan counts by, so a comment in
                // `our_count` is a comment highlighted here.
                products: productsIn(c.text),
              })),
              total: read.total,
              complete: read.complete,
              unresolved: read.unresolved,
            })
          } catch {
            // A dead video must not take the rest of the channel with it.
            live.set(url, {
              comments: [],
              total: null,
              complete: false,
              unresolved: true,
            })
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker)
      )
    }

    const links: Record<string, unknown> = {}
    for (const url of urls) {
      // In full mode a link the deadline cut off is LEFT OUT entirely rather
      // than returned empty: absent means "not read yet, ask again", and empty
      // would mean "read, and there is nothing there".
      if (body?.full === true && !live.has(url)) continue
      const s = scans[url]
      links[url] = {
        ours: ours[url] ?? [],
        top: s?.topText ? { text: s.topText, user: s.topUser, likes: s.topLikes } : null,
        // How much of the video the SCAN read. A read cut off halfway is not
        // evidence that our comment is absent — it is evidence that we stopped
        // looking.
        read: s?.readCount ?? null,
        total: s?.totalCount ?? null,
        complete: s?.complete ?? false,
        scannedAt: s?.scannedAt ?? null,
        ...(live.get(url) ? { live: live.get(url) } : {}),
      }
    }
    return NextResponse.json({
      links,
      // How many of the links asked for did not fit in this request. The caller
      // presses again and picks up from here.
      remaining: body?.full === true ? urls.length - live.size : 0,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
