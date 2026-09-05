import { NextRequest, NextResponse } from 'next/server'
import { getClickersOnDay, blockUser, addAdminMessage, canAutoBlock, dbNow } from '@/lib/db'
import { scoreUserDay, noCommentVerdict, BLOCK_SAMPLE } from '@/lib/commentPresence'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Nightly: for everyone who opened links today, check how many of those links
// actually carry a comment from their own account, and store the day's score.
//
// A user whose comment appears on NONE of a 50-link sample is auto-blocked (see
// noCommentVerdict). The sample is topped up from earlier days when the day
// itself is short, unjudgeable links never count toward it, and one found
// comment anywhere stops it — so a block means fifty consecutive links with
// nothing on any of them. The admin can unblock from the dashboard.
//
// RESUMABLE BY DESIGN. Scoring one user takes ~10–25 seconds (six links at 1–5s
// each), so a single 60-second invocation covers only two or three users. The
// cron therefore runs repeatedly through the evening and each run skips users
// already scored for the day, picking up where the last one stopped.
//
// Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else is rejected.

/** Leave room to write the last row and respond. */
const BUDGET_MS = 50_000

/**
 * How long a verdict stays good before the link is read again.
 *
 * A stored true/false is a claim about a moment. Comments get deleted, hidden
 * after the fact, or posted an hour after the link was opened, and none of that
 * reaches the ledger — so a day scored once in the morning would be reported all
 * evening as though nothing had changed.
 *
 * It cannot be zero. The cron is resumable precisely because it skips links it
 * has already judged; treating every run as a clean slate would re-read the same
 * two users forever and never reach the rest. A window keeps both: runs inside
 * it converge, and once it lapses the day is verified again from the videos.
 */
const FRESH_HOURS = Math.max(0.25, Number(process.env.PRESENCE_FRESH_HOURS || 6))

/** The day being scored, as YYYY-MM-DD in UTC. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }
  // ?day=YYYY-MM-DD re-scores an earlier day (a missed night, say).
  const day = req.nextUrl.searchParams.get('day') || todayUtc()

  try {
    const clickers = await getClickersOnDay(day)
    // Already-scored users are skipped, which is what makes repeated runs
    // converge instead of re-doing the same two people every time.
    // NOT "has a row": a row exists as soon as the first link is judged. Only
    // a user whose every link is in the ledger is finished, and scoreUserDay
    // reports that itself — so nothing is filtered out here beyond users who
    // cannot be scored at all.
    const pending = clickers

    // Anything judged before this is re-read from the video. Taken from the
    // database clock, since it is compared against checked_at which now() wrote.
    const nowIso = await dbNow().catch(() => new Date().toISOString())
    const freshSince = new Date(Date.parse(nowIso) - FRESH_HOURS * 3_600_000).toISOString()

    const deadline = Date.now() + BUDGET_MS
    const scored: { userId: string; judged: number; remaining: number; total: number }[] = []
    const blocked: { userId: string; judged: number }[] = []
    for (const c of pending) {
      if (scored.length > 0 && Date.now() >= deadline) break
      const r = await scoreUserDay(c.userId, c.tiktokUrl, day, deadline, freshSince)
      if (r) scored.push({ userId: c.userId, ...r })

      // Auto-block only once THIS user's day is fully judged — a partial day
      // says nothing yet. noCommentVerdict tops the sample up from earlier days
      // when the day itself is short, and refuses to block on a small sample.
      if (r && r.remaining === 0 && (await canAutoBlock(c.userId).catch(() => false))) {
        const v = await noCommentVerdict(c.userId, c.tiktokUrl, deadline).catch(() => null)
        if (v?.block) {
          // 'tiktok' is the right reason: it tells them to register a different
          // TikTok account, which is the remedy whether their comments are being
          // suppressed or were never posted.
          // auto = true: the badge shows this differently from a block an
          // admin decided, so a machine's verdict is never mistaken for yours.
          await blockUser(c.userId, 'tiktok', true).catch(() => {})
          // Deliberately vague. Spelling out the sample size and that comments
          // are being checked would just teach anyone gaming it exactly how
          // much to do — and the admin can explain properly case by case.
          await addAdminMessage(
            c.userId,
            'Your account has been paused. Please contact the admin.'
          ).catch(() => {})
          blocked.push({ userId: c.userId, judged: v.judged })
        }
      }

      // A user with links left keeps this run busy; the next invocation picks
      // them up again, since the ledger records what has already been judged.
      if (r && r.remaining > 0) break
    }

    return NextResponse.json({
      ok: true,
      day,
      clickers: clickers.length,
      usersTouched: scored.length,
      linksJudged: scored.reduce((a, x) => a + x.judged, 0),
      usersWithLinksLeft: scored.filter((x) => x.remaining > 0).length,
      blockSample: BLOCK_SAMPLE,
      // How stale a verdict was allowed to be on this run, before the link was
      // read again.
      freshHours: FRESH_HOURS,
      autoBlocked: blocked,
      scored,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
