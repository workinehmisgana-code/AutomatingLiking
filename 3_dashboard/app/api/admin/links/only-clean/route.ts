import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getServeOnlyClean,
  setServeOnlyClean,
  getUrlsWithProductComments,
  clearCleanSessionClicks,
} from '@/lib/db'
import { loadVideosJson } from '@/lib/videos'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Serve only links that carry none of our comments.
//
// OFF BY DEFAULT. On, every link already known to carry one of our product
// comments is withheld from the app and the web dashboard, so a session goes to
// videos nobody has commented on yet.
//
// The GET reports what the switch would cost before it is thrown: how many links
// it withholds and how many are left. A toggle that silently cuts the pool by
// 90% is one nobody can use with confidence.
//
//   GET               the current state, with the numbers behind it
//   POST { on }       turn it on or off

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const [on, withOurs, videos] = await Promise.all([
      getServeOnlyClean(),
      getUrlsWithProductComments().catch(() => [] as string[]),
      loadVideosJson().catch(() => [] as { url?: unknown }[]),
    ])
    const pool = new Set(
      videos.map((v) => String((v as { url?: unknown }).url ?? '')).filter(Boolean)
    )
    // Only the ones actually IN the pool: link_product_comment keeps rows for
    // links long since replaced, and counting those would overstate the cost.
    let withheld = 0
    for (const u of withOurs) if (pool.has(u)) withheld++
    return NextResponse.json({
      ok: true,
      on,
      withheld,
      remaining: pool.size - withheld,
      total: pool.size,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { on?: unknown }
  try {
    const on = await setServeOnlyClean(body.on === true)
    // Every switch starts a new session. Turning it OFF is the one the ask
    // names — the session's clicks must not outlive it — and clearing on the way
    // IN is what makes "since the last time it was turned on" true even if it is
    // switched on twice without an off in between.
    const cleared = await clearCleanSessionClicks().catch(() => 0)
    return NextResponse.json({ ok: true, on, cleared })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
