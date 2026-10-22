import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { listCaptchaRequests, answerCaptchaRequest } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * The phone's end of the remote captcha relay.
 *
 * GET returns whatever is waiting on a person; POST sends one answer back. The
 * worker's end is /api/captcha, which is token-authenticated because a script
 * cannot sign in with Google. This end is the ordinary admin login, because the
 * person holding the phone can.
 *
 * WHAT AN ANSWER IS:
 *   { angle: 0…360 }        a rotate puzzle: how far round the inner disc goes.
 *                           The worker converts that to a drag along the track.
 *   { points: [[x,y], …] }  any other kind: taps as FRACTIONS of the widget
 *                           (0–1 each), which the worker multiplies back up.
 *                           Fractions, not pixels, because the phone is showing
 *                           a picture scaled to its own screen.
 *   { refresh: true }       ask TikTok for a different puzzle.
 *   { give_up: true }       stop waiting; the account is skipped for this run.
 */
async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const requests = await listCaptchaRequests()
    return NextResponse.json({ ok: true, requests, now: new Date().toISOString() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const id = String(body?.id ?? '').trim()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  // Exactly one of the four shapes, validated here rather than trusted: the
  // worker turns this into mouse movements in a browser signed in to a real
  // account, so a malformed answer is a drag to nowhere and a burnt puzzle.
  let answer: Record<string, unknown> | null = null
  if (body?.give_up === true) answer = { give_up: true }
  else if (body?.refresh === true) answer = { refresh: true }
  else if (Array.isArray(body?.points)) {
    const points: [number, number][] = []
    for (const p of body.points as unknown[]) {
      if (!Array.isArray(p) || p.length < 2) continue
      const x = Number(p[0])
      const y = Number(p[1])
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (x < 0 || x > 1 || y < 0 || y > 1) continue
      points.push([Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000])
    }
    if (points.length === 0) {
      return NextResponse.json({ error: 'points must be fractions 0–1' }, { status: 400 })
    }
    answer = { points: points.slice(0, 8) }
  } else if (body?.angle !== undefined) {
    const angle = Number(body.angle)
    if (!Number.isFinite(angle)) {
      return NextResponse.json({ error: 'angle must be a number' }, { status: 400 })
    }
    // Wrapped rather than rejected: a slider dragged past the end is a person
    // saying "all the way round", and 361 degrees means one degree.
    answer = { angle: ((angle % 360) + 360) % 360 }
  }
  if (!answer) {
    return NextResponse.json(
      { error: 'send angle, points, refresh or give_up' },
      { status: 400 }
    )
  }

  try {
    const saved = await answerCaptchaRequest(id, answer)
    // Already answered is not an error worth a red banner — two taps on a slow
    // connection land as two requests, and the first one is the one that counts.
    return NextResponse.json({ ok: true, saved, answer })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
