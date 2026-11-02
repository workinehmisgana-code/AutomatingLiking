import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getOurRatioRetirePct, getOurRatioRetiredUrls, setOurRatioRetirePct } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Retire a TikTok link once our comments make up this share of its comments
// (see OUR_RATIO_RETIRE_DEFAULT in lib/config).
//
//   GET              { pct, retired }  retired = scanned links at or over it now
//   POST { pct }     save it (0 = off)

async function admin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const pct = await getOurRatioRetirePct().catch(() => 0)
  const retired = pct > 0 ? (await getOurRatioRetiredUrls(pct).catch(() => [])).length : 0
  return NextResponse.json({ pct, retired })
}

export async function POST(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { pct?: unknown }
  try {
    const pct = await setOurRatioRetirePct(body.pct)
    const retired = pct > 0 ? (await getOurRatioRetiredUrls(pct).catch(() => [])).length : 0
    return NextResponse.json({ ok: true, pct, retired })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
