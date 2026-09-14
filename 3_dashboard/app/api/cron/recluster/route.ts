import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getReclusterState, reclusterIfDue } from '@/lib/recluster'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Rescore the whole pool for the posted-date clusters, once an hour.
//
// SEPARATE FROM THE PIPELINE on purpose. The six-hourly cycle reclusters at the
// end of its lap, but a lap takes hours of actual working time — so between laps
// the scores drift, and they drift on their own: the score is relative, so every
// link added and every link blocked moves where the rest sit.
//
// The SCHEDULE fires on the hour; the DUE CHECK inside reclusterIfDue decides.
// A missed or retried cron therefore costs nothing and skips nothing, and an
// admin refreshing this page cannot force a rescore of 133k links.
//
// WHO MAY CALL IT
//  * Vercel's scheduler, with `Authorization: Bearer $CRON_SECRET`.
//  * A signed-in admin, so a deploy can be followed by a run instead of waiting
//    for the next hour.
//
// GET reports where it stands without moving it — only the scheduler's GET does
// the work. POST always attempts it, still subject to the due check.

function isCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

async function authorised(req: NextRequest): Promise<boolean> {
  if (isCron(req)) return true
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (isAdminEmail(session?.user?.email)) return true
  // No secret configured at all: let the scheduler through rather than have the
  // recluster silently never run.
  return !process.env.CRON_SECRET
}

export async function GET(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isCron(req)) {
    return NextResponse.json({ ok: true, ...(await getReclusterState()) })
  }
  try {
    return NextResponse.json({ ok: true, ...(await reclusterIfDue()) })
  } catch (e) {
    return NextResponse.json({ error: `Recluster failed: ${String(e)}` }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json({ ok: true, ...(await reclusterIfDue()) })
  } catch (e) {
    return NextResponse.json({ error: `Recluster failed: ${String(e)}` }, { status: 500 })
  }
}
