import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { loadVideosJson } from '@/lib/videos'
import {
  getBrokenLinks,
  recordBrokenReadings,
  clearBrokenReadings,
  getConfirmedBrokenUrls,
} from '@/lib/db'
import { checkLivenessBatch, BROKEN_AFTER_MISSES } from '@/lib/linkStats'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Find links the platform no longer serves, and let them come back.
//
// BATCHED like the counts refresh: one request cannot read 150k embeds, so the
// client posts an offset, this works to its own deadline and says where to
// resume. Nothing is held between batches beyond the rows already written, so
// closing the tab just stops the run.
//
// A link is not condemned on one dead reading — see BROKEN_AFTER_MISSES. The
// same empty response comes back from a rate limit, and a single bad minute
// must not be able to empty the pool.
//
//   GET                          the broken list, paged
//   POST { offset }              check the next slice of the pool
//   POST { recheck: [...urls] }  read those again; any that answer are restored
//   POST { restore: [...urls] }  put them back by hand, without checking

/** Stop fetching here, leaving room to write rows and respond. */
const BUDGET_MS = 40_000
const CONCURRENCY = 8
/** Cap per request, so one batch cannot run unboundedly if the platform is fast. */
const MAX_BATCH = 400
/** Most links re-checked in one go from the modal. */
const MAX_RECHECK = 200

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limit = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 200))
  const offset = Math.max(0, Number(req.nextUrl.searchParams.get('offset')) || 0)
  try {
    const { rows, total } = await getBrokenLinks(limit, offset)
    const confirmed = await getConfirmedBrokenUrls(BROKEN_AFTER_MISSES)
    return NextResponse.json({
      ok: true,
      rows,
      total,
      // Rows below the threshold are suspected, not withheld — the modal says so.
      withheld: confirmed.length,
      threshold: BROKEN_AFTER_MISSES,
      limit,
      offset,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as {
    offset?: unknown
    limit?: unknown
    recheck?: unknown
    restore?: unknown
  }

  // ── put back by hand ──────────────────────────────────────────────────────
  if (Array.isArray(body.restore)) {
    const urls = body.restore.map((u) => String(u ?? '').trim()).filter(Boolean)
    try {
      return NextResponse.json({ ok: true, restored: await clearBrokenReadings(urls) })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // ── read these again ──────────────────────────────────────────────────────
  if (Array.isArray(body.recheck)) {
    const urls = body.recheck
      .map((u) => String(u ?? '').trim())
      .filter(Boolean)
      .slice(0, MAX_RECHECK)
    if (urls.length === 0) return NextResponse.json({ ok: true, restored: 0, stillBroken: 0 })
    try {
      const { results } = await checkLivenessBatch(urls, CONCURRENCY, Date.now() + BUDGET_MS)
      const alive = results.filter((r) => r.state === 'alive').map((r) => r.url)
      const dead = results.filter((r) => r.state === 'broken')
      const restored = await clearBrokenReadings(alive)
      for (const reason of Array.from(new Set(dead.map((r) => r.reason)))) {
        await recordBrokenReadings(
          dead.filter((r) => r.reason === reason).map((r) => r.url),
          reason,
          BROKEN_AFTER_MISSES
        )
      }
      return NextResponse.json({
        ok: true,
        checked: results.length,
        restored,
        stillBroken: dead.length,
        // Unreadable this time — left exactly as they were.
        unknown: results.filter((r) => r.state === 'unknown').length,
      })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // ── sweep the pool ────────────────────────────────────────────────────────
  const offset = Math.max(0, Number(body.offset) || 0)
  const limit = Math.min(MAX_BATCH, Math.max(1, Number(body.limit) || MAX_BATCH))
  try {
    const videos = (await loadVideosJson()) as { url?: unknown }[]
    const urls = videos.map((v) => String(v.url ?? '')).filter((u) => u.startsWith('http'))
    const total = urls.length
    if (offset >= total) {
      return NextResponse.json({
        ok: true, total, nextOffset: total, done: true,
        checked: 0, alive: 0, broken: 0, unknown: 0, newlyBroken: 0, restored: 0,
      })
    }
    const slice = urls.slice(offset, offset + limit)
    const { results, consumed } = await checkLivenessBatch(
      slice,
      CONCURRENCY,
      Date.now() + BUDGET_MS
    )

    const alive = results.filter((r) => r.state === 'alive').map((r) => r.url)
    const dead = results.filter((r) => r.state === 'broken')
    // Every link that answered clears its record, listed or not: that is what
    // makes a run of near-misses reset instead of accumulating across passes
    // until an intermittent link is condemned.
    const restored = await clearBrokenReadings(alive)
    let newlyBroken = 0
    for (const reason of Array.from(new Set(dead.map((r) => r.reason)))) {
      newlyBroken += await recordBrokenReadings(
        dead.filter((r) => r.reason === reason).map((r) => r.url),
        reason,
        BROKEN_AFTER_MISSES
      )
    }

    // Advance past everything ATTEMPTED, not everything that answered —
    // advancing by successes alone would re-read the failures forever.
    const nextOffset = offset + Math.max(consumed, results.length)
    return NextResponse.json({
      ok: true,
      total,
      nextOffset,
      done: nextOffset >= total,
      checked: results.length,
      alive: alive.length,
      broken: dead.length,
      unknown: results.filter((r) => r.state === 'unknown').length,
      newlyBroken,
      restored,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
