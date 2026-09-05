import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getUserProfile,
  getLastActiveDay,
  getJudgedLinkRows,
  getPresenceHistory,
  dbNow,
  type PresenceDay,
} from '@/lib/db'
import { scoreUserDay, handleFromProfile } from '@/lib/commentPresence'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Verify one user, exactly the way the bulk sweep does.
//
// This used to read the SAMPLE LINKS a user submitted with their work report.
// It now reads the links they actually OPENED on their last active day — the
// same population, cap and scoring as /api/admin/comment-presence — so a single
// user's number means the same thing as everyone else's, and users no longer
// have to submit sample links at all.
//
// Resumable: a day runs to 100 judged links, well past one request, so each call
// judges what it can and reports how many are left. The ledger makes repeats
// idempotent.

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
  // this same check are reused, which is what lets a 100-link user finish over
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

  const day = await getLastActiveDay(userId).catch(() => null)
  if (!day) {
    return NextResponse.json(
      { error: 'This user has never opened a TikTok link, so there is nothing to check.' },
      { status: 400 }
    )
  }

  try {
    const r = await scoreUserDay(userId, profile!.tiktok_url!, day, Date.now() + BUDGET_MS, since)
    if (!r) {
      return NextResponse.json({ error: 'Could not score this user.' }, { status: 500 })
    }
    const [links, hist] = await Promise.all([
      getJudgedLinkRows(userId, day),
      getPresenceHistory(30).catch(() => ({}) as Record<string, PresenceDay[]>),
    ])
    const score = (hist[userId] ?? []).find((d) => d.day === day)
    return NextResponse.json({
      ok: true,
      username,
      day,
      // Echoed back so every request in this check shares one freshness cutoff.
      since,
      // Totals come from the ledger, so they are right even mid-run.
      checked: score?.checked ?? 0,
      found: score?.found ?? 0,
      skipped: score?.skipped ?? 0,
      pct: score?.pct ?? null,
      opened: r.opened,
      total: r.total,
      remaining: r.remaining,
      done: r.remaining === 0,
      links,
    })
  } catch (e) {
    return NextResponse.json({ error: `Verification failed: ${String(e)}` }, { status: 500 })
  }
}
