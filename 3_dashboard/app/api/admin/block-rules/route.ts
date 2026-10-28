import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, BLOCK_RULE_BOUNDS, BLOCK_RULE_DEFAULTS } from '@/lib/config'
import { getBlockRules, saveBlockRules } from '@/lib/db'

export const dynamic = 'force-dynamic'

// The numbers the automatic check blocks people on.
//
// They were constants in the source, which meant the only way to change a
// judgement made nightly about somebody's account was a deploy — and the one
// number that WAS adjustable, the empty-sample size, was a field on the manual
// sweep that the cron and the per-user button both ignored. So three callers ran
// three different rules and the dashboard showed no sign of it.
//
// Now they are stored (app_kv) and read in one place, noCommentVerdict, so every
// caller applies whatever is set here.
//
// GET  → the current rules, the bounds, and the defaults
// POST → { on?, sample?, ratioSample?, ratioMinPct? }, clamped, returns what stuck

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const rules = await getBlockRules().catch(() => BLOCK_RULE_DEFAULTS)
  return NextResponse.json({
    ok: true,
    rules,
    bounds: BLOCK_RULE_BOUNDS,
    defaults: BLOCK_RULE_DEFAULTS,
  })
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    on?: unknown
    sample?: unknown
    ratioSample?: unknown
    ratioMinPct?: unknown
    genreMinPct?: unknown
    genreSample?: unknown
  }
  try {
    // Clamping happens in saveBlockRules, and an omitted field means UNCHANGED —
    // so a page that only knows about one of these cannot reset the others, and
    // an empty input box cannot mean "the harshest setting there is".
    const rules = await saveBlockRules({
      on: typeof body.on === 'boolean' ? body.on : undefined,
      sample: body.sample as number | undefined,
      ratioSample: body.ratioSample as number | undefined,
      ratioMinPct: body.ratioMinPct as number | undefined,
      genreMinPct: body.genreMinPct as number | undefined,
      genreSample: body.genreSample as number | undefined,
    })
    return NextResponse.json({ ok: true, rules, bounds: BLOCK_RULE_BOUNDS })
  } catch (e) {
    return NextResponse.json(
      { error: `Could not save the rules: ${String(e)}` },
      { status: 500 }
    )
  }
}
