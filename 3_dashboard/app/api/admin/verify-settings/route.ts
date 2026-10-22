import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, VERIFY_GATE_ENABLED, VERIFY_MIN_AGE_DAYS } from '@/lib/config'
import {
  getMinAccountAgeDays,
  setMinAccountAgeDays,
  getVerifyVideoUrl,
  setVerifyVideoUrl,
  MIN_AGE_FLOOR,
  MIN_AGE_CEILING,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

// The account-age gate's two settings.
//
//   GET                      what they are now
//   POST { minAgeDays }      move the floor
//   POST { videoUrl }        point at a different video
//
// Stored rather than compiled in, because both are judgements that change with
// the market: how many brand-new accounts are turning up, and how busy the
// current video's comment list has become. Neither should need a deploy.

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const [minAgeDays, videoUrl] = await Promise.all([
      getMinAccountAgeDays(),
      getVerifyVideoUrl(),
    ])
    return NextResponse.json({
      ok: true,
      minAgeDays,
      videoUrl,
      // So the card can say whether any of this is actually in force.
      gateEnabled: VERIFY_GATE_ENABLED,
      defaultMinAgeDays: VERIFY_MIN_AGE_DAYS,
      floor: MIN_AGE_FLOOR,
      ceiling: MIN_AGE_CEILING,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let body: { minAgeDays?: unknown; videoUrl?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  try {
    // Each is optional, so one can be changed without restating the other.
    if (body.minAgeDays !== undefined) {
      await setMinAccountAgeDays(Number(body.minAgeDays))
    }
    if (body.videoUrl !== undefined) {
      await setVerifyVideoUrl(String(body.videoUrl))
    }
    const [minAgeDays, videoUrl] = await Promise.all([
      getMinAccountAgeDays(),
      getVerifyVideoUrl(),
    ])
    return NextResponse.json({ ok: true, minAgeDays, videoUrl })
  } catch (e) {
    // setMinAccountAgeDays and setVerifyVideoUrl both throw a sentence meant
    // for a person, so it is sent through rather than replaced.
    return NextResponse.json({ error: (e as Error).message || String(e) }, { status: 400 })
  }
}
