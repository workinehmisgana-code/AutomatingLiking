import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import {
  isAdminEmail,
  isProduct,
  COMMENT_WORD_MIN,
  COMMENT_WORD_MAX,
  DEFAULT_COMMENT_STYLE,
  type CommentStyle,
} from '@/lib/config'
import {
  getProductCommentSettings,
  setProductWordBand,
  setProductCommentStyle,
  normaliseWordBand,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

const DEFAULTS = { min: COMMENT_WORD_MIN, max: COMMENT_WORD_MAX }

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// GET ?product=x — that product's comment length band (falls back to defaults).
export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const product = String(req.nextUrl.searchParams.get('product') ?? '').trim()
  if (!isProduct(product)) return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
  try {
    const { band, style } = await getProductCommentSettings(product, DEFAULTS)
    return NextResponse.json({ product, ...band, ...style, defaults: DEFAULTS })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST { product, min, max } — set the band. Values are clamped to 1..60 and
// ordered, because a reversed or absurd band would reject every rewrite the
// generator produces and silently leave the product with no comments.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const product = String(body?.product ?? '').trim()
  if (!isProduct(product)) return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
  const band = normaliseWordBand(body?.min, body?.max, DEFAULTS)
  // An absent flag means 'leave it alone', so the current value is read first
  // rather than assumed: a client that only sends min/max must not silently
  // reset the writing style to the defaults.
  const current = await getProductCommentSettings(product, DEFAULTS).catch(() => ({
    band: DEFAULTS,
    style: DEFAULT_COMMENT_STYLE,
  }))
  const flag = (v: unknown, was: boolean): boolean => (typeof v === 'boolean' ? v : was)
  const style: CommentStyle = {
    emoji: flag(body?.emoji, current.style.emoji),
    splitBrand: flag(body?.splitBrand, current.style.splitBrand),
    quoteBrand: flag(body?.quoteBrand, current.style.quoteBrand),
  }
  try {
    await setProductWordBand(product, band)
    await setProductCommentStyle(product, style)
    return NextResponse.json({ ok: true, product, ...band, ...style })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
