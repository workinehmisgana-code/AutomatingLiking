import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getRecentClickers,
  getPresenceHistory,
  blockUser,
  addAdminMessage,
  canAutoBlock,
  dbNow,
  type PresenceDay,
} from '@/lib/db'
import {
  scoreUserDay,
  handleFromProfile,
  noCommentVerdict,
  clampBlockSample,
  BLOCK_SAMPLE,
  MIN_BLOCK_SAMPLE,
  MAX_BLOCK_SAMPLE,
} from '@/lib/commentPresence'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Admin sweep: score every recently-active user's comment presence on demand.
//
// Each user is scored against EVERY link they opened on their OWN last active
// day — someone who worked Monday and not since is judged on Monday's work.
//
// Resumable at LINK level, not just user level: one user can open 160 links and
// reading them takes minutes, so a request judges what it can, writes it to the
// ledger, and reports whether that user still has links left. The client keeps
// calling with the same offset until the user is finished, then moves on.

const BUDGET_MS = 45_000
/** How far back counts as "active". */
const ACTIVE_DAYS = 7

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const users = await getRecentClickers(ACTIVE_DAYS).catch(() => [])
  return NextResponse.json({ total: users.length, activeDays: ACTIVE_DAYS })
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    offset?: unknown
    since?: unknown
    blockSample?: unknown
  }
  const offset = Math.max(0, Number(body.offset) || 0)

  // How many JUDGED links a user must have with no comment of theirs on any of
  // them before this sweep blocks them. Chosen per sweep, clamped to a range
  // that can actually be satisfied — see MIN/MAX_BLOCK_SAMPLE. Absent means the
  // long-standing 50, so an old client keeps the behaviour it expects.
  const blockSample =
    body.blockSample === undefined || body.blockSample === null
      ? BLOCK_SAMPLE
      : clampBlockSample(body.blockSample)

  // When this sweep began. Everything judged before it is stale and gets read
  // again, so the report is what the videos say NOW rather than a replay of
  // whatever the last pass concluded — a comment can be deleted, hidden or
  // posted late, and a stored boolean shows none of that.
  //
  // Taken from the DATABASE clock, because it is compared against checked_at
  // which is written by now(). It is handed back to the client and echoed on
  // every follow-up request, so one sweep keeps one cutoff: links this sweep
  // has already judged are reused (that is what makes a 160-link user
  // resumable), and links judged by any earlier sweep are not.
  const rawSince = typeof body.since === 'string' ? body.since : ''
  const since =
    rawSince && !Number.isNaN(Date.parse(rawSince))
      ? new Date(rawSince).toISOString()
      : await dbNow().catch(() => new Date().toISOString())

  try {
    // Re-read the roster each call rather than trusting the client: the order is
    // stable (last click desc) so an offset means the same thing across calls.
    const users = await getRecentClickers(ACTIVE_DAYS)
    const total = users.length
    if (offset >= total) {
      return NextResponse.json({
        ok: true, total, since, blockSample, nextOffset: total, done: true, results: [],
      })
    }

    const deadline = Date.now() + BUDGET_MS
    const results: {
      userId: string
      username: string
      day: string
      checked: number
      found: number
      skipped: number
      pct: number | null
      remaining: number
      /** Set when this sweep auto-blocked them, with the sample it acted on. */
      blocked?: { judged: number }
    }[] = []
    let cursor = offset

    while (cursor < total && Date.now() < deadline) {
      const u = users[cursor]
      const username = handleFromProfile(u.tiktokUrl)
      if (!username) {
        cursor++
        continue
      }
      const r = await scoreUserDay(u.userId, u.tiktokUrl, u.lastDay, deadline, since)
      if (!r) {
        cursor++
        continue
      }
      // Totals come from the ledger, so they are right even when this request
      // only judged part of the user's links.
      const hist = await getPresenceHistory(ACTIVE_DAYS + 1).catch(
        () => ({}) as Record<string, PresenceDay[]>
      )
      const day = (hist[u.userId] ?? []).find((d) => d.day === u.lastDay)
      // Same auto-block rule as the nightly cron, so a manual sweep and the
      // cron cannot reach different conclusions about the same person. Only
      // once this user's day is fully judged — a partial day says nothing —
      // and never twice, since re-blocking would overwrite an admin's own
      // unblock with a machine verdict.
      let blocked: { judged: number } | undefined
      if (r.remaining === 0 && (await canAutoBlock(u.userId).catch(() => false))) {
        const v = await noCommentVerdict(u.userId, u.tiktokUrl, deadline, blockSample).catch(
          () => null
        )
        if (v?.block) {
          // 'tiktok' tells them to register a different TikTok account, which is
          // the remedy whether their comments are suppressed or were never
          // posted. auto = true keeps the badge distinct from your own blocks.
          await blockUser(u.userId, 'tiktok', true).catch(() => {})
          await addAdminMessage(
            u.userId,
            'Your account has been paused. Please contact the admin.'
          ).catch(() => {})
          blocked = { judged: v.judged }
        }
      }
      results.push({
        userId: u.userId,
        username,
        day: u.lastDay,
        checked: day?.checked ?? 0,
        found: day?.found ?? 0,
        skipped: day?.skipped ?? 0,
        pct: day?.pct ?? null,
        remaining: r.remaining,
        blocked,
      })
      // Only move on once this user's day is fully judged; otherwise the next
      // call resumes them at the same offset.
      if (r.remaining > 0) break
      cursor++
    }

    return NextResponse.json({
      ok: true,
      total,
      // Echoed back so every request in this sweep shares one freshness cutoff.
      since,
      // The sample actually used, after clamping — so the page shows what
      // happened rather than what was asked for.
      blockSample,
      blockSampleRange: { min: MIN_BLOCK_SAMPLE, max: MAX_BLOCK_SAMPLE },
      nextOffset: cursor,
      done: cursor >= total,
      results,
    })
  } catch (e) {
    return NextResponse.json({ error: `Sweep failed: ${String(e)}` }, { status: 500 })
  }
}
