import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { GENRES, genreWeights, isAdminEmail } from '@/lib/config'
import { getGenreMix, saveGenreMix } from '@/lib/db'

export const dynamic = 'force-dynamic'

// How much of a worker's list each product genre gets.
//
// Three numbers, read by BOTH feeds — the web dashboard and the Android app —
// so a change here changes what every worker is shown next.
//
// The numbers are SHARES, not a schedule: 60/20/15 means the same split as
// 63/21/16, and the server normalises rather than refusing to save. `weights` in
// the response is what the feeds will actually use, so the page can show the
// effect of what was typed instead of the typing.

async function admin() {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const mix = await getGenreMix().catch(() => null)
  return NextResponse.json({ mix: mix ?? {}, weights: genreWeights(mix), genres: [...GENRES] })
}

export async function PATCH(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400 })
  }
  // Only the genres actually sent are changed, so a form that posts one field
  // cannot zero the other two.
  const patch: Record<string, number> = {}
  for (const g of GENRES) {
    if (body[g] !== undefined) patch[g] = Number(body[g])
  }
  // Clamped inside saveGenreMix, which owns the bounds and returns what was
  // stored — so the form always shows the value the feeds will use.
  const mix = await saveGenreMix(patch)
  return NextResponse.json({ ok: true, mix, weights: genreWeights(mix) })
}
