import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, SCAN_MAX_LINKS } from '@/lib/config'
import { buildAdminLinks, filterAdminLinks, type LinkQuery, type ClusterBy } from '@/lib/adminLinks'
import { saveLinkScan, startScanRun, getScanRunUrls, recordScanRunBatch } from '@/lib/db'
import { scanLink } from '@/lib/commentScan'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Read the comments of the links currently filtered on the Links page, recording
// which of OUR product comments are already on each one and where they sit.
//
// SCOPED TO 1–5 CLUSTERS on purpose. Reading a video's comments takes 1–5
// seconds, so a cluster of ~900 links is already close to an hour; the whole
// pool would be days. The client refuses to start without a cluster selection,
// and this refuses too — a filter that accidentally matched everything would
// otherwise queue an unbounded job.
//
// EVERY PRESS IS A FRESH READ. It used to skip links any earlier scan had
// touched, which made a second press almost free and almost pointless: the
// numbers never moved, because nothing was read again. Now a press opens a RUN
// and skips only what that run has already read — resumable across requests,
// while still re-reading every link from scratch each time you press it.
//
// Each run is recorded (link_scan_run), so the history modal can plot how our
// comments on a set of links change from one scan to the next. Runs are grouped
// by SCOPE — the cluster selection and filters — because two scopes cover
// different links and their totals are not comparable.

const BUDGET_MS = 45_000
/** Comment reads in flight. Same ceiling as the presence sweep. */
const CONCURRENCY = 4

function parseQuery(sp: URLSearchParams): LinkQuery {
  const num = (v: string | null) => {
    if (v == null || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const list = (v: string | null) =>
    (v ?? '')
      .split(',')
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n))
  return {
    platform: sp.get('platform') || '',
    product: sp.get('product') || '',
    keyword: sp.get('keyword') || '',
    uploadDate: sp.get('uploadDay') || sp.get('uploadDate') || '',
    titleFilter: (sp.get('titleFilter') || '') as LinkQuery['titleFilter'],
    mediaFilter: (sp.get('media') || '') as LinkQuery['mediaFilter'],
    clusters: list(sp.get('clusters')),
    clusterBy: (sp.get('clusterBy') || 'rank') as ClusterBy,
    minClicks: num(sp.get('minClicks')),
    maxClicks: num(sp.get('maxClicks')),
    minRatio: num(sp.get('minRatio')),
    maxRatio: num(sp.get('maxRatio')),
    q: sp.get('q') || '',
  }
}

/**
 * What set of links a run covered, as a key and a readable label.
 *
 * Only the fields that change WHICH links are in the set. Two runs with the same
 * key scanned the same links, so their numbers can sit on one line; two with
 * different keys cannot be compared at all and are kept apart on the graph.
 */
function scopeFor(qy: LinkQuery): { key: string; label: string } {
  const clusters = [...(qy.clusters ?? [])].sort((a, b) => a - b)
  const parts: string[] = [
    `by=${qy.clusterBy ?? 'rank'}`,
    `clusters=${clusters.join('.') || 'all'}`,
    `platform=${qy.platform || 'all'}`,
    `product=${qy.product || 'all'}`,
    `keyword=${qy.keyword || ''}`,
    `upload=${qy.uploadDate || ''}`,
    `title=${qy.titleFilter || ''}`,
    `media=${qy.mediaFilter || ''}`,
    `clicks=${qy.minClicks ?? ''}-${qy.maxClicks ?? ''}`,
    `ratio=${qy.minRatio ?? ''}-${qy.maxRatio ?? ''}`,
    `q=${qy.q || ''}`,
  ]
  const bits: string[] = []
  bits.push(clusters.length ? `${qy.clusterBy ?? 'rank'} cluster ${clusters.join(', ')}` : 'all clusters')
  if (qy.platform) bits.push(qy.platform)
  if (qy.keyword) bits.push(`"${qy.keyword}"`)
  if (qy.uploadDate) bits.push(qy.uploadDate)
  if (qy.titleFilter) bits.push(qy.titleFilter)
  if (qy.mediaFilter) bits.push(qy.mediaFilter)
  if (qy.q) bits.push(`search "${qy.q}"`)
  return { key: parts.join('|'), label: bits.join(' · ') }
}

/** The filtered URLs this endpoint may scan, in a stable order. */
async function targetUrls(sp: URLSearchParams): Promise<{ urls: string[]; error?: string }> {
  const qy = parseQuery(sp)
  const { rows, retirePlatforms } = await buildAdminLinks(qy.product ?? '')
  const filtered = filterAdminLinks(rows, qy, retirePlatforms)
  // TikTok only: the comment endpoint has no equivalent elsewhere. Blocked links
  // are skipped — nobody will ever be sent there.
  const urls = filtered
    .filter((l) => !l.blocked && /tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i.test(l.url))
    .map((l) => l.url)
  urls.sort()
  // Counted on what will actually be READ, which is at most what the filter
  // shows: the page disables the button above the same limit, so this can only
  // ever be the backstop for a request that did not come from the page.
  if (urls.length > SCAN_MAX_LINKS) {
    return {
      urls: [],
      error:
        `${urls.length.toLocaleString()} links match — narrow the filter to ` +
        `${SCAN_MAX_LINKS.toLocaleString()} or fewer. Each one costs a few seconds of reading.`,
    }
  }
  if (urls.length === 0) {
    return { urls: [], error: 'No TikTok links match this filter.' }
  }
  return { urls }
}

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { urls, error } = await targetUrls(req.nextUrl.searchParams)
  if (error) return NextResponse.json({ error }, { status: 400 })
  // No 'already scanned' count any more: a press re-reads everything, so the
  // number would only ever have been misleading.
  return NextResponse.json({ total: urls.length })
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    offset?: unknown
    query?: unknown
    runId?: unknown
  }
  const offset = Math.max(0, Number(body.offset) || 0)
  const sp = new URLSearchParams(String(body.query ?? ''))
  const givenRun = Number(body.runId)
  const runId = Number.isFinite(givenRun) && givenRun > 0 ? givenRun : null

  try {
    const { urls, error } = await targetUrls(sp)
    if (error) return NextResponse.json({ error }, { status: 400 })
    const total = urls.length
    if (offset >= total) {
      return NextResponse.json({
        ok: true, total, nextOffset: total, done: true, scanned: 0, withOurs: 0, runId,
      })
    }

    // The first request of a press opens the run; the client echoes its id on
    // every request after, so one press is one row in the history.
    const scope = scopeFor(parseQuery(sp))
    const run = runId ?? (await startScanRun(scope.key, scope.label))

    // Only what THIS run has read. Links read by an earlier press are read
    // again — that is the point of pressing the button.
    const done = await getScanRunUrls(run).catch(() => new Set<string>())
    const deadline = Date.now() + BUDGET_MS

    // Walk forward from the offset, skipping links this run already covered.
    // Skipped links still advance the cursor, so resuming costs one pass of
    // database reads and no TikTok traffic.
    const queue: string[] = []
    let cursor = offset
    while (cursor < total && queue.length < 40) {
      const u = urls[cursor]
      cursor++
      if (!done.has(u)) queue.push(u)
    }

    let scanned = 0
    let withOurs = 0
    let next = 0
    // Gathered rather than written per link: one aggregate update per batch
    // keeps the run's totals consistent even if two requests overlap.
    const batch: { url: string; readCount: number; ourCount: number; products: Record<string, number> }[] = []
    const worker = async () => {
      for (;;) {
        if (scanned > 0 && Date.now() >= deadline) return
        const i = next++
        if (i >= queue.length) return
        const r = await scanLink(queue[i])
        if (r.unresolved) {
          scanned++
          continue
        }
        await saveLinkScan({
          url: r.url,
          readCount: r.readCount,
          totalCount: r.totalCount,
          complete: r.complete,
          ourCount: r.ourCount,
          bestRank: r.bestRank,
          topText: r.top?.text ?? null,
          topUser: r.top?.username ?? null,
          topLikes: r.top?.likes ?? null,
          hits: r.hits,
        }).catch(() => {})
        scanned++
        if (r.ourCount > 0) withOurs++
        const products: Record<string, number> = {}
        for (const h of r.hits) products[h.product] = (products[h.product] ?? 0) + 1
        batch.push({
          url: r.url,
          readCount: r.readCount,
          ourCount: r.ourCount,
          products,
        })
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    await recordScanRunBatch(run, batch).catch(() => {})

    // If the deadline cut the queue short, resume at the first link not reached
    // rather than at the cursor — otherwise the tail would be skipped silently.
    const reached = Math.min(next, queue.length)
    const nextOffset = reached >= queue.length ? cursor : offset + reached

    return NextResponse.json({
      ok: true,
      total,
      nextOffset,
      done: nextOffset >= total,
      scanned,
      withOurs,
      // Echoed by the client on every following request, so one press stays one
      // run — without it each request would open its own and the history would
      // fill with fragments.
      runId: run,
      scopeLabel: scope.label,
    })
  } catch (e) {
    return NextResponse.json({ error: `Scan failed: ${String(e)}` }, { status: 500 })
  }
}
