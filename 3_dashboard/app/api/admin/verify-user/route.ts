import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getUserProfile,
  dbNow,
  autoBlockStatus,
  blockUser,
  addAdminMessage,
  getFoundComments,
} from '@/lib/db'
import {
  BLOCK_SAMPLE,
  RATIO_MIN_PCT,
  RATIO_SAMPLE,
  RECENT_SAMPLE,
  noCommentVerdict,
  scoreUserRecent,
  handleFromProfile,
  tally,
} from '@/lib/commentPresence'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Verify one user against their LAST 100 LINKS.
//
// The population has moved twice, and each move was away from something that
// made the number mean less:
//
//   sample links       the user chose which links to submit with their report.
//   one day, in full   the links they actually opened on their last active day.
//                      Honest, but a day is whatever length it happens to be —
//                      eleven links on a quiet one, 1,373 on the biggest — so the
//                      answer was not comparable between two users, or between
//                      the same user on two days.
//   the last 300       the same question, the same size, for everybody. It spans
//                      days, which is the point: it is the most recent 300 links,
//                      not the most recent day's worth. Three hundred because the
//                      rate rule needs 200 JUDGED ones and roughly 15% of reads
//                      cannot be judged — see RECENT_SAMPLE.
//
// The same reads, the same judging and the same ledger as the nightly sweep; only
// which links get read is different. The per-day score rows are NOT rewritten
// from this sample — a hundred links across five days is a slice of each, and a
// slice must not redefine a day (see refreshDay in saveJudgedLinks).
//
// Resumable: 300 links is many requests' worth, so each call judges what it can
// and reports how many are left; the page keeps calling until nothing is. The
// ledger makes repeats idempotent.
//
// AND IT CAN BLOCK, once the check is finished. Two rules, either of which is
// enough, and both are noCommentVerdict's so the cron, the sweep and this button
// cannot disagree about somebody:
//
//   nothing on their last 50 judged links      — they are not commenting at all
//   under 10% of their last 200 judged links   — they are commenting occasionally
//                                                and claiming a full day's work
//
// The second exists because the first has a gap somebody can sit in indefinitely:
// on the real data, five users had 1, 2, 7, 10 and 15 comments found across 200
// judged links, and one comment anywhere clears the first rule completely.
// The decision is noCommentVerdict's, the same function the nightly cron and the
// bulk sweep use, so pressing this button cannot reach a different conclusion
// about somebody than the cron would. What it adds is the timing: the admin gets
// the verdict while they are looking at the person, instead of overnight.
//
// Everything that makes that rule cautious still applies: 50 links have to be
// actually JUDGED (unreadable ones are topped up from older links, never counted
// as misses), one comment found anywhere stops it dead, a short sample never
// blocks, and an admin's own unblock is never overridden — canAutoBlock refuses a
// second machine block. Nothing here is irreversible.

const BUDGET_MS = 45_000

/** Whether a machine may block this person at all. */
async function canBlock(userId: string): Promise<boolean> {
  const st = await autoBlockStatus(userId).catch(() => ({ blocked: true, exempt: true }))
  return !st.blocked && !st.exempt
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as { userId?: unknown; since?: unknown }
  const userId = String(body.userId ?? '').trim()

  // The freshness cutoff for THIS check, minted here on the first request and
  // echoed by the client on every one after. Links judged before it are read
  // from the video again, so this reports what is there NOW; links judged by
  // this same check are reused, which is what lets a 100-link check finish over
  // several requests.
  const rawSince = typeof body.since === 'string' ? body.since : ''
  const since =
    rawSince && !Number.isNaN(Date.parse(rawSince))
      ? new Date(rawSince).toISOString()
      : await dbNow().catch(() => new Date().toISOString())
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })

  const profile = await getUserProfile(userId).catch(() => null)
  const username = handleFromProfile(profile?.tiktok_url ?? '')
  if (!username) {
    return NextResponse.json(
      { error: "This user has no usable TikTok profile link — there's no @username to look for. Edit their links first." },
      { status: 400 }
    )
  }

  try {
    const r = await scoreUserRecent(
      userId,
      profile!.tiktok_url!,
      RECENT_SAMPLE,
      Date.now() + BUDGET_MS,
      since
    )
    if (!r) {
      return NextResponse.json(
        { error: 'This user has never opened a TikTok link, so there is nothing to check.' },
        { status: 400 }
      )
    }
    // Totals over the sample itself, by the same rule the day score uses: a link
    // that could not be read is left out of the percentage rather than held
    // against the user.
    const score = tally(r.links)
    // WHICH COMMENTS WERE FOUND, AND ON HOW MANY LINKS EACH. Read back from the
    // ledger rather than from this request's results, so it covers the whole
    // sample — including the links judged by an earlier request of the same
    // check, whose text is in the ledger and not in this response.
    const comments = await getFoundComments(
      userId,
      r.links.map((l) => ({ url: l.url, day: l.day }))
    ).catch(() => [])

    // ── the block, only on the last request of the check ───────────────────
    //
    // ONLY WHEN THE CHECK IS FINISHED. A partial pass says nothing: the links it
    // has not reached yet are exactly where a comment might be.
    let blocked:
      | { judged: number; skipped: number; rule?: string; pct?: number | null }
      | undefined
    let blockNote = ''
    if (r.remaining === 0) {
      if (!(await canBlock(userId))) {
        // WHICH ONE, because they mean opposite things to whoever pressed the
        // button. Exempt is a decision somebody made about this person — often
        // because their comments are known to be suppressed — and it is why a
        // check can come back 0% and block nobody.
        const st = await autoBlockStatus(userId).catch(() => null)
        blockNote = !st
          ? 'not blocked — could not read their block status'
          : st.blocked
            ? 'not blocked — they are already blocked'
            : 'not blocked — they are on the auto-block exempt list'
      } else {
        const v = await noCommentVerdict(
          userId,
          profile!.tiktok_url!,
          Date.now() + BUDGET_MS,
          BLOCK_SAMPLE
        ).catch(() => null)
        // A HIT NO LONGER ENDS IT. It clears the first rule and the second one
        // still has something to say: a comment on one link in two hundred is a
        // comment, and it is not a day's work.
        if (v?.block) {
          // 'tiktok' tells them to register a different TikTok account, which is
          // the remedy whether their comments are suppressed or were never
          // posted. auto = true keeps the badge distinct from an admin's own
          // block.
          //
          // AND ONLY REPORTED IF IT HAPPENED. This used to swallow the error and
          // report the block anyway, which is the worst of both: the admin is
          // told somebody is blocked and walks away, and nobody is.
          const applied = await blockUser(userId, 'tiktok', true).then(
            () => true,
            () => false
          )
          if (applied) {
            // Deliberately vague — spelling out the sample size would teach
            // anyone gaming it exactly how much to do, and the admin can explain
            // properly case by case.
            await addAdminMessage(
              userId,
              'Your account has been paused. Please contact the admin.'
            ).catch(() => {})
            blocked = {
              judged: v.rule === 'ratio' ? (v.ratio?.judged ?? 0) : v.judged,
              skipped: v.skipped,
              rule: v.rule,
              pct: v.ratio?.pct ?? null,
            }
          } else {
            blockNote =
              `the rule says block (${
                v.rule === 'ratio'
                  ? `${v.ratio?.pct ?? 0}% of ${v.ratio?.judged ?? 0} judged`
                  : `0 of ${v.judged} judged`
              }) but the block could not be written — try again, or block them from their row`
          }
        } else if (v) {
          // WHY NOT, in the terms of whichever rule came closest. Both have to be
          // answerable, or a 0% report that blocks nobody looks like a bug.
          const rate = v.ratio
          blockNote =
            rate && rate.judged >= RATIO_SAMPLE
              ? `not blocked — ${rate.pct}% of their last ${rate.judged} judged links carry ` +
                `their comment, and the rule needs under ${RATIO_MIN_PCT}%`
              : rate && rate.judged > 0
                ? `not blocked — ${v.found} found on ${v.judged} judged recently, and only ` +
                  `${rate.judged} of the ${RATIO_SAMPLE} judged links the rate rule needs ` +
                  'have been read'
                : v.found > 0
                  ? `not blocked — a comment turned up on ${v.found} link(s) further back`
                  : `not blocked — only ${v.judged} of the ${BLOCK_SAMPLE} links needed could ` +
                    `be judged${v.skipped ? ` (${v.skipped} unreadable)` : ''}`
        }
      }
    }
    return NextResponse.json({
      ok: true,
      username,
      // Echoed back so every request in this check shares one freshness cutoff.
      since,
      sample: RECENT_SAMPLE,
      checked: score.checked,
      found: score.found,
      skipped: score.skipped,
      pct: score.pct,
      total: r.total,
      from: r.days[0] ?? '',
      to: r.days[r.days.length - 1] ?? '',
      days: r.days.length,
      remaining: r.remaining,
      done: r.remaining === 0,
      links: r.links,
      // The distinct comments found, most-used first. The frequency is the
      // interesting part: one comment on forty links is somebody pasting the same
      // line all day, which reads as automation to anyone looking at the video.
      comments,
      // What the auto-block rule did, and when it did nothing, why — a button
      // that can block somebody must never be silent about not having.
      blockSample: BLOCK_SAMPLE,
      ratioSample: RATIO_SAMPLE,
      ratioMinPct: RATIO_MIN_PCT,
      blocked,
      blockNote,
    })
  } catch (e) {
    return NextResponse.json({ error: `Verification failed: ${String(e)}` }, { status: 500 })
  }
}
