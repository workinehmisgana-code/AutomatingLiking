import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getUserProfile, dbNow } from '@/lib/db'
import { RECENT_SAMPLE, scoreUserRecent, handleFromProfile, tally } from '@/lib/commentPresence'

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
//   the last 100       the same question, the same size, for everybody. It spans
//                      days, which is the point: it is the most recent hundred
//                      links, not the most recent day's worth.
//
// The same reads, the same judging and the same ledger as the nightly sweep; only
// which links get read is different. The per-day score rows are NOT rewritten
// from this sample — a hundred links across five days is a slice of each, and a
// slice must not redefine a day (see refreshDay in saveJudgedLinks).
//
// Resumable: 100 links is well past one request, so each call judges what it can
// and reports how many are left. The ledger makes repeats idempotent.

const BUDGET_MS = 45_000

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
    })
  } catch (e) {
    return NextResponse.json({ error: `Verification failed: ${String(e)}` }, { status: 500 })
  }
}
