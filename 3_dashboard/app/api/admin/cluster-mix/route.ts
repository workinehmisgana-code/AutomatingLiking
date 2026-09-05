import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getClusterDateShare, setClusterDateShare } from '@/lib/db'
import { DEFAULT_DATE_SHARE } from '@/lib/clusterMix'

export const dynamic = 'force-dynamic'

// How the two clusterings are mixed when links are served: the percentage of
// links drawn from the posted-date ordering, the rest from search rank.
//
// One number, read by both feeds — the Android app blends per link, the web
// dashboard picks a side per user — so changing it here changes both.

async function admin() {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const dateShare = await getClusterDateShare().catch(() => DEFAULT_DATE_SHARE)
  return NextResponse.json({ dateShare, rankShare: 100 - dateShare })
}

export async function PATCH(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let body: { dateShare?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Expected JSON' }, { status: 400 })
  }
  // Clamped rather than rejected: setClusterDateShare owns the bounds, and an
  // empty field means the default instead of 0 — see clampShare.
  const dateShare = await setClusterDateShare(Number(body.dateShare))
  return NextResponse.json({ ok: true, dateShare, rankShare: 100 - dateShare })
}
