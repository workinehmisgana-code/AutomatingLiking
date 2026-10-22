import { NextRequest, NextResponse } from 'next/server'
import { getClickersOnDay, blockUser, addAdminMessage, canAutoBlock, dbNow } from '@/lib/db'
import {
  scoreUserRecent,
  noCommentVerdict,
  BLOCK_SAMPLE,
  RECENT_SAMPLE,
} from '@/lib/commentPresence'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Nightly: for everyone who opened links today, read their LAST 300 LINKS and
// check how many carry a comment from their own account.
//
// THE LAST 300, NOT THE DAY. It used to score whichever links the user opened
// today, in full — honest, but not comparable: a day is whatever length it
// happens to be, so one user was judged on eleven links and another on 1,373, and
// the same person meant something different on Monday than on Tuesday. The admin's
// verify button already reads a fixed 300 for exactly that reason, and a nightly
// check that uses a different population than the button is a check nobody can
// reconcile with what they see on screen.
//
// Three hundred also feeds the rate rule, which needs 200 JUDGED links and gets
// about 255 out of 300 read (roughly 15% cannot be judged).
//
// BOTH BLOCK RULES APPLY, and they are noCommentVerdict's, so this cron, the
// manual sweep and the button cannot reach different conclusions about somebody:
//
//   nothing found on N judged links       — they are not commenting at all
//   under P% of their last M judged links — they comment occasionally and claim
//                                           a full day's work
//
// N, P and M are set on the dashboard. Unjudgeable links count toward neither,
// one comment found anywhere stops the first rule, a sample too small to judge
// blocks nobody, and the admin can unblock from the dashboard.
//
// RESUMABLE BY DESIGN, and it has to be: 300 links a person at 1–5 seconds each
// is minutes per user, so one 60-second invocation covers a fraction of one
// window. The cron runs every five minutes through the evening, each run skips
// what the ledger already holds (see FRESH_HOURS) and stops at the first user
// with links left, so the next run continues them rather than starting somebody
// else halfway.
//
// A window that does not finish tonight simply does not produce a verdict: the
// block only runs when `remaining` reaches zero.
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

/** The hour the nightly window opens, in UTC. Matches vercel.json's schedule. */
const WINDOW_START_HOUR = Math.min(
  23,
  Math.max(0, Number(process.env.PRESENCE_WINDOW_START_HOUR || 17))
)

/**
 * The instant every run tonight measures its windows from.
 *
 * THE WINDOW HAS TO STAND STILL OR NOTHING EVER FINISHES. A user's window is
 * their newest 300 TikTok links, and these users open 150-400 a day — so each
 * run judged links that the day's clicking then pushed out of the window, and
 * the next run found the same 300 unjudged again. The ledger showed it exactly:
 * three users with 150 links judged and 150 opened since, back to a full window.
 * A verdict is only reached on a FINISHED window, so the check blocked nobody
 * who was still working, which is everybody worth checking.
 *
 * Derived rather than stored, so it needs no table and every run of a given
 * night agrees on it without coordinating: the most recent WINDOW_START_HOUR
 * boundary. Runs before that hour (a manual call, a backfill) pin to the
 * previous night's boundary, which is equally stable.
 */
function windowPin(now = new Date()): string {
  const pin = new Date(now)
  pin.setUTCMinutes(0, 0, 0)
  if (now.getUTCHours() < WINDOW_START_HOUR) {
    pin.setUTCDate(pin.getUTCDate() - 1)
  }
  pin.setUTCHours(WINDOW_START_HOUR)
  return pin.toISOString()
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }
  // WHICH PEOPLE, NOT WHICH LINKS. The day now selects whose windows to read —
  // everyone who opened something that day — and the window itself is always
  // their last RECENT_SAMPLE links, whenever those were opened. ?day=YYYY-MM-DD
  // therefore means "check the people who were active then", which is what it is
  // useful for after a missed night.
  const day = req.nextUrl.searchParams.get('day') || todayUtc()

  try {
    const clickers = await getClickersOnDay(day)
    // Already-scored users are skipped, which is what makes repeated runs
    // converge instead of re-doing the same two people every time.
    // NOT "has a row": a row exists as soon as the first link is judged. Only
    // a user whose whole window is in the ledger is finished, and scoreUserRecent
    // reports that itself — so nothing is filtered out here beyond users who
    // cannot be scored at all.
    const pending = clickers

    // Anything judged before this is re-read from the video. Taken from the
    // database clock, since it is compared against checked_at which now() wrote.
    const nowIso = await dbNow().catch(() => new Date().toISOString())
    const freshSince = new Date(Date.parse(nowIso) - FRESH_HOURS * 3_600_000).toISOString()

    // One pin for every run tonight: the same 300 links each time, so the work
    // accumulates instead of being undone by the day's clicking.
    const pinned = windowPin()
    const deadline = Date.now() + BUDGET_MS
    const scored: { userId: string; judged: number; remaining: number; total: number }[] = []
    const blocked: { userId: string; judged: number; rule?: string; pct?: number | null }[] = []
    for (const c of pending) {
      if (scored.length > 0 && Date.now() >= deadline) break
      // refreshDays: this is the only pass that reads these links now, so the
      // per-day rows behind the dashboard's history are rebuilt as it goes —
      // from the whole ledger for each day, never from this window's slice.
      const r = await scoreUserRecent(
        c.userId,
        c.tiktokUrl,
        RECENT_SAMPLE,
        deadline,
        freshSince,
        true,
        pinned
      )
      if (r) scored.push({ userId: c.userId, judged: r.judged, remaining: r.remaining, total: r.total })

      // Auto-block only once THIS user's window is fully judged — a partial pass
      // says nothing yet, because the links it has not reached are exactly where
      // a comment might be. noCommentVerdict then applies both rules.
      if (r && r.remaining === 0 && (await canAutoBlock(c.userId).catch(() => false))) {
        // The SAME pin, or the verdict would read a different set of links
        // than the pass that just declared the window finished.
        const v = await noCommentVerdict(
          c.userId,
          c.tiktokUrl,
          deadline,
          undefined,
          pinned
        ).catch(() => null)
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
          blocked.push({
            userId: c.userId,
            judged: v.rule === 'ratio' ? (v.ratio?.judged ?? 0) : v.judged,
            rule: v.rule,
            pct: v.ratio?.pct ?? null,
          })
        }
      }

      // A user with links left keeps this run busy; the next invocation picks
      // them up again, since the ledger records what has already been judged.
      if (r && r.remaining > 0) break
    }

    return NextResponse.json({
      ok: true,
      // The day whose CLICKERS were checked. Their links may be older: each one
      // is judged over their last `sample` links, not over this day's.
      day,
      sample: RECENT_SAMPLE,
      // The instant the windows are measured from. Every run tonight reports
      // the same one; if it moves between runs, nothing will ever finish.
      pinnedAt: pinned,
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
