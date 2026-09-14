import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import {
  COMMENT_WORD_MAX,
  COMMENT_WORD_MIN,
  DEFAULT_COMMENT_STYLE,
  isAdminEmail,
  isProduct,
} from '@/lib/config'
import { getProductCommentSettings, getProductPrompt, setProductPrompt } from '@/lib/db'
import { buildSystemPrompt } from '@/lib/commentPrompt'

export const dynamic = 'force-dynamic'

// The system prompt for one product, so it can be read and edited before a
// generation rather than only inferred from its output.
//
// GET returns BOTH: the prompt built from the current settings (voice, word
// band, brand switches) and the admin's saved edit if there is one. The page
// shows the saved edit when it exists and the built one otherwise, and can put
// the built one back.
//
// An edit REPLACES the built prompt wholesale. That is deliberate: a prompt
// stitched together from an edit plus the settings would leave you unable to
// remove any instruction you disagreed with, which is the main reason to edit
// one at all. The settings that shape wording still apply after the model
// replies — the word band, the brand spelling and the voice filters are
// enforced by the sanitiser either way, so an edited prompt cannot quietly
// produce comments the rest of the system rejects.

const DEFAULTS = { min: COMMENT_WORD_MIN, max: COMMENT_WORD_MAX }

async function admin() {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const product = String(req.nextUrl.searchParams.get('product') ?? '').trim()
  if (!isProduct(product)) return NextResponse.json({ error: 'Unknown product' }, { status: 400 })

  const { band, style } = await getProductCommentSettings(product, DEFAULTS).catch(() => ({
    band: DEFAULTS,
    style: DEFAULT_COMMENT_STYLE,
  }))
  const built = buildSystemPrompt(product, band, style)
  const saved = await getProductPrompt(product).catch(() => null)
  return NextResponse.json({ ok: true, product, built, saved, using: saved ?? built })
}

export async function POST(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let body: { product?: unknown; prompt?: unknown } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const product = String(body.product ?? '').trim()
  if (!isProduct(product)) return NextResponse.json({ error: 'Unknown product' }, { status: 400 })

  // Blank means "use the built one", which is how Reset works — there is no
  // separate delete, so the box can never be saved into a state you cannot
  // leave.
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  try {
    await setProductPrompt(product, prompt)
    const saved = await getProductPrompt(product).catch(() => null)
    return NextResponse.json({ ok: true, product, saved })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
