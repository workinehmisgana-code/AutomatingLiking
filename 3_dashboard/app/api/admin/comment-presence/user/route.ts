import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getPresenceLinks,
  getPresenceHistoryForUser,
  setPresenceCommentText,
  getUserProfile,
  getUserNameEmail,
  saveLinkStats,
  type PresenceLinkRow,
} from '@/lib/db'
import { handleFromProfile } from '@/lib/commentPresence'
import { fetchComments, fetchStat } from '@/lib/linkStats'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// One user's judged links, for the modal behind a name in the presence report.
//
// Everything here is already in the ledger, so the common case is a single
// query and no network at all. Two gaps are filled on demand:
//
//  * comment_text is null for anything judged before the column existed. Only
//    FOUND links are re-read, and only a handful — those are the rows where the
//    text is the point, and there are never many of them.
//  * hearts/views are null for links the counts refresh has not reached. Same
//    treatment, same cap, and whatever is fetched is written back so the second
//    open of the modal is free.
//
// Both are capped and deadline-bounded: a report that takes twenty seconds to
// open is worse than one with a few blanks in it.
const BACKFILL_TEXT = 12
const BACKFILL_STATS = 20
const BUDGET_MS = 25_000
/** Most links one modal will show. Also the point past which gap maths is cut. */
const LINK_LIMIT = 400
/**
 * Longest gap still counted as working pace.
 *
 * Anything above this is a break, not a rhythm. Two minutes is generous next to
 * the app's own 12-22 second cooldown: it leaves room to watch a video and type
 * a comment, while excluding the pauses that made the raw average meaningless.
 */
const WORKING_GAP_MAX_SEC = 120

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const userId = String(req.nextUrl.searchParams.get('userId') ?? '').trim()
  if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  const days = Math.max(1, Math.min(60, Number(req.nextUrl.searchParams.get('days')) || 7))

  try {
    const [profile, info, rows, history] = await Promise.all([
      getUserProfile(userId).catch(() => null),
      getUserNameEmail(userId).catch(() => null),
      getPresenceLinks(userId, days, LINK_LIMIT),
      getPresenceHistoryForUser(userId, days).catch(() => []),
    ])
    const username = handleFromProfile(profile?.tiktok_url ?? '')
    const deadline = Date.now() + BUDGET_MS

    // ── fill in missing comment text ──────────────────────────────────────
    if (username) {
      const missing = rows.filter((r) => r.found && !r.text).slice(0, BACKFILL_TEXT)
      for (const r of missing) {
        if (Date.now() >= deadline) break
        const read = await fetchComments(r.url, 3).catch(() => null)
        if (!read) continue
        const hit = read.comments.find((c) => c.username === username)
        // A miss here is not a re-judgement: the comment may simply have fallen
        // past the pages we read. The stored verdict stands.
        if (hit || read.total !== null) {
          r.text = hit?.text ?? r.text
          r.comments = r.comments ?? read.total
          await setPresenceCommentText(userId, r.day, r.url, hit?.text ?? null, read.total).catch(
            () => {}
          )
        }
      }
    }

    // ── fill in missing hearts/views ──────────────────────────────────────
    const noStats = rows.filter((r) => r.hearts === null && r.views === null).slice(0, BACKFILL_STATS)
    if (noStats.length > 0 && Date.now() < deadline) {
      const fetched: { url: string; hearts: number | null; views: number | null; isPhoto: boolean | null }[] = []
      for (const r of noStats) {
        if (Date.now() >= deadline) break
        const stat = await fetchStat(r.url).catch(() => null)
        if (!stat) continue
        r.hearts = stat.hearts
        r.views = stat.views
        r.isPhoto = stat.isPhoto
        fetched.push(stat)
      }
      if (fetched.length > 0) await saveLinkStats(fetched).catch(() => {})
    }

    const judged = rows.filter((r) => r.judgeable)
    const found = judged.filter((r) => r.found)

    // Gaps between consecutive clicks, WITHIN a day and under WORKING_GAP_MAX.
    //
    // Both filters remove the same thing: time the person was not working. A
    // gap across days is an overnight break, and a gap of ten minutes is lunch.
    // Left in, they dominate — the unfiltered mean came out near five minutes
    // for every user on record, while their real rhythm ranged from 5 to 39
    // seconds, so the number said nothing about anyone.
    // The reader caps at LINK_LIMIT rows, and the cut lands mid-day for a heavy
    // user. Gaps computed across a day that is missing half its clicks would be
    // inflated nonsense, so the oldest day is dropped when the cap was hit.
    const truncated = rows.length >= LINK_LIMIT
    const oldestDay = truncated ? rows[rows.length - 1].day : null
    const byDay = new Map<string, number[]>()
    for (const r of rows) {
      if (!r.clickedAt) continue
      if (r.day === oldestDay) continue
      const t = new Date(r.clickedAt).getTime()
      if (!Number.isFinite(t)) continue
      byDay.set(r.day, [...(byDay.get(r.day) ?? []), t])
    }
    const gaps: number[] = []
    for (const times of Array.from(byDay.values())) {
      times.sort((a, b) => a - b)
      for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000)
    }
    const working = gaps.filter((g) => g <= WORKING_GAP_MAX_SEC).sort((a, b) => a - b)
    const breaks = gaps.length - working.length
    const avgGapSec =
      working.length > 0 ? working.reduce((a, b) => a + b, 0) / working.length : null
    const medGapSec = working.length > 0 ? working[Math.floor(working.length / 2)] : null
    return NextResponse.json({
      ok: true,
      userId,
      username,
      name: profile?.name || info?.name || info?.email || userId,
      days,
      totals: {
        links: rows.length,
        judged: judged.length,
        found: found.length,
        missing: judged.length - found.length,
        skipped: rows.length - judged.length,
      },
      timing: {
        // `gaps` is what the averages are over; `breaks` is what was left out.
        gaps: working.length,
        breaks,
        maxGapSec: WORKING_GAP_MAX_SEC,
        truncated,
        avgGapSec: avgGapSec === null ? null : Math.round(avgGapSec * 10) / 10,
        medGapSec: medGapSec === null ? null : Math.round(medGapSec * 10) / 10,
      },
      // Oldest first, so a trend line reads left to right without re-sorting.
      history,
      links: rows as PresenceLinkRow[],
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
