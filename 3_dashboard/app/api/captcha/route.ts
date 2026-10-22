import { NextResponse, type NextRequest } from 'next/server'
import {
  createCaptchaRequest,
  getCaptchaRequest,
  closeCaptchaRequest,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * The liker's end of the remote captcha relay.
 *
 * A run stops dead when TikTok puts a rotation puzzle in front of an account,
 * and until now clearing it meant being at the machine the run is on. The worker
 * now posts the puzzle here instead and polls for the answer; /admin/captcha
 * shows it on a phone. See the captcha_request table in lib/db.ts for why the
 * relay lives in this app rather than in the liker's own control panel.
 *
 * Protected by LINKS_EXPORT_TOKEN, the same arrangement as /api/links/export and
 * /api/links/clusters: the caller is a script that cannot run Google OAuth.
 *
 *   POST   /api/captcha            { token, profile, kind, … }  -> { id }
 *   GET    /api/captcha?token&id                                -> { answer }
 *   DELETE /api/captcha?token&id                                -> { ok }
 *
 * The ANSWER is polled rather than pushed because the worker is behind a home
 * router with nothing listening on it — that is the whole reason this relay
 * exists. Polling every couple of seconds for a few minutes, only while a run is
 * actually blocked, is a handful of queries.
 */
/**
 * Header, query string, or the posted body.
 *
 * THE BODY MATTERS. The worker's publish carries the token inside its JSON, and
 * a check that only read the header and the query answered 401 to every publish
 * while the GET beside it worked — a failure that looks exactly like a wrong
 * token and is not one. So the body is a source too, and the caller may use
 * whichever it finds natural.
 */
function authorised(req: NextRequest, body?: Record<string, unknown>): boolean {
  const token = process.env.LINKS_EXPORT_TOKEN
  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    req.nextUrl.searchParams.get('token') ||
    String(body?.token ?? '').trim() ||
    ''
  return Boolean(token) && provided === token
}

/** Base64 with no data: prefix, and nothing absurdly large. */
function image(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const payload = s.includes(',') && s.startsWith('data:') ? s.split(',', 2)[1] : s
  // A captcha image is a few tens of kilobytes. A megabyte of base64 is not one,
  // and storing it would be storing whatever was sent instead.
  if (payload.length > 1_400_000) return null
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) return null
  return payload.replace(/\s+/g, '')
}

export async function POST(req: NextRequest) {
  // The body is read BEFORE the check, because the token may be in it. Parsing
  // untrusted JSON first is safe; acting on it before the check would not be.
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!authorised(req, body)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const profile = String(body?.profile ?? '').trim().slice(0, 40)
  if (!profile) return NextResponse.json({ error: 'profile is required' }, { status: 400 })
  const kind = String(body?.kind ?? 'unknown').trim().slice(0, 20) || 'unknown'
  const outer = image(body?.outer)
  const inner = image(body?.inner)
  const shot = image(body?.shot)
  // Nothing to look at is not a request a person can answer, so it is refused
  // here rather than appearing on the phone as an empty card.
  if (!(outer && inner) && !shot) {
    return NextResponse.json(
      { error: 'need either outer+inner (rotate) or shot (any other kind)' },
      { status: 400 }
    )
  }
  const num = (v: unknown): number | null => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 && n < 10_000 ? n : null
  }
  try {
    const id = await createCaptchaRequest({
      profile,
      kind,
      instruction: String(body?.instruction ?? '').slice(0, 300),
      outer,
      inner,
      shot,
      boxW: num(body?.boxW),
      boxH: num(body?.boxH),
    })
    return NextResponse.json({ ok: true, id })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = String(req.nextUrl.searchParams.get('id') ?? '').trim()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  try {
    const r = await getCaptchaRequest(id)
    // GONE, not "no answer yet". A row pruned or replaced means the worker
    // should stop waiting, and it cannot tell the two apart from a null answer.
    if (!r) return NextResponse.json({ ok: true, found: false, answer: null })
    // The images are not sent back: the worker posted them and a poll every two
    // seconds must not carry a hundred kilobytes with it.
    return NextResponse.json({
      ok: true,
      found: true,
      answer: r.answer,
      answeredAt: r.answeredAt,
      profile: r.profile,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  if (!authorised(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const id = String(req.nextUrl.searchParams.get('id') ?? '').trim()
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  try {
    await closeCaptchaRequest(id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
