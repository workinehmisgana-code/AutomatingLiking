import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getPipelineCycles, getCycleCoverage } from '@/lib/db'
import { getStage, getLastTick, getCycleTiming, CYCLE_HOURS } from '@/lib/pipeline'

export const dynamic = 'force-dynamic'

// What the automatic cycle has been doing: where it is now, and every turn it
// has taken. Read-only — opening the report must never start work.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const [cycles, stage, last, timing] = await Promise.all([
      getPipelineCycles(60),
      getStage(),
      getLastTick(),
      getCycleTiming(),
    ])
    // The two most recent cycles that actually read something, newest first.
    // Coverage is a comparison, so it needs both; with only one cycle recorded
    // there is nothing to compare against and the report says so.
    const withScans = cycles.filter((c) => Number((c.stages.extract ?? {}).read) > 0)
    const [later, earlier] = withScans
    const coverage =
      later && earlier
        ? {
            laterId: later.id,
            earlierId: earlier.id,
            laterAt: later.startedAt,
            earlierAt: earlier.startedAt,
            rank: await getCycleCoverage(earlier.id, later.id, 'rank').catch(() => []),
            date: await getCycleCoverage(earlier.id, later.id, 'date').catch(() => []),
          }
        : null

    return NextResponse.json({
      ok: true,
      cycles,
      stage,
      last,
      timing,
      everyHours: CYCLE_HOURS,
      coverage,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
