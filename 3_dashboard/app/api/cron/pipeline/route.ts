import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { tick, getStage, getLastTick, STAGES } from '@/lib/pipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The automatic cycle, one slice per call:
//
//   harvest -> extract comments -> categorise -> recluster -> harvest -> ...
//
// See lib/pipeline for what each stage does. This file is only the door.
//
// HOW OFTEN TO CALL IT
// A call does ~45 seconds of work. The extract stage alone covers about 7,375
// links at roughly one a second, so a full lap needs a couple of hours of actual
// working time. Called once an hour it would spend 45 seconds working and 59
// minutes idle, and a lap would take over a week. The schedule in vercel.json
// therefore fires it every few minutes; the LAP is what completes on the order of
// hours, not the tick.
//
// WHO MAY CALL IT
//  * Vercel's scheduler, with `Authorization: Bearer $CRON_SECRET`.
//  * A signed-in admin, so a deploy can be followed by an immediate run instead
//    of waiting for the next scheduled minute.
//
// GET reports where the cycle is without moving it, which is what the admin page
// reads. Only the scheduler's GET actually works.

/** Leave room to write rows and respond inside maxDuration. */
const BUDGET_MS = 45_000

function isCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

async function authorised(req: NextRequest): Promise<boolean> {
  if (isCron(req)) return true
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (isAdminEmail(session?.user?.email)) return true
  // No secret configured at all: let the scheduler through rather than have the
  // cycle silently never run.
  return !process.env.CRON_SECRET
}

export async function GET(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isCron(req)) {
    // An admin opening the page should never start work by looking at it.
    return NextResponse.json({
      ok: true,
      stages: STAGES,
      stage: await getStage(),
      last: await getLastTick().catch(() => null),
    })
  }
  try {
    return NextResponse.json({ ok: true, ...(await tick(Date.now() + BUDGET_MS)) })
  } catch (e) {
    return NextResponse.json({ error: `Pipeline failed: ${String(e)}` }, { status: 500 })
  }
}

/** POST advances the cycle. This is how the admin page runs one on demand. */
export async function POST(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json({ ok: true, ...(await tick(Date.now() + BUDGET_MS)) })
  } catch (e) {
    return NextResponse.json({ error: `Pipeline failed: ${String(e)}` }, { status: 500 })
  }
}
