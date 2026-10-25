import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import {
  isAdminEmail,
  isProduct,
  COMMENT_WORD_MIN,
  COMMENT_WORD_MAX,
  DEFAULT_COMMENT_STYLE,
  isCommentVoice,
  isTopListRank,
  clampTopList,
  DEFAULT_TOP_LIST,
  TOP_LIST_BOUNDS,
  type CommentStyle,
  type TopListSetting,
} from '@/lib/config'
import {
  getProductCommentSettings,
  setProductWordBand,
  setProductCommentStyle,
  setProductTopList,
  getTopCommentsForProduct,
  normaliseWordBand,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

const DEFAULTS = { min: COMMENT_WORD_MIN, max: COMMENT_WORD_MAX }

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// GET ?product=x — that product's settings: length band, writing style, and the
// "serve the measured top list" setting.
//
// With ?list=1 it also returns the list itself. The list is computed from the
// query's count/rank/days when those are given, NOT only from what is saved, so
// the page can show what a change would serve BEFORE it is saved. Without them
// it falls back to the saved setting.
export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const product = String(req.nextUrl.searchParams.get('product') ?? '').trim()
  if (!isProduct(product)) return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
  try {
    const { band, style, top } = await getProductCommentSettings(product, DEFAULTS)
    const sp = req.nextUrl.searchParams
    const wantList = sp.get('list') === '1'
    // The preview overrides. Absent ones keep the saved value; 'enabled' is never
    // taken from the query, because asking to SEE a list is not asking to use it.
    const preview: TopListSetting = clampTopList({
      ...top,
      count: sp.get('count') ?? top.count,
      rank: isTopListRank(sp.get('rank')) ? (sp.get('rank') as TopListSetting['rank']) : top.rank,
      days: sp.get('days') ?? top.days,
    })
    const list = wantList ? await getTopCommentsForProduct(product, preview).catch(() => []) : null
    return NextResponse.json({
      product,
      ...band,
      ...style,
      top,
      topBounds: TOP_LIST_BOUNDS,
      topDefaults: DEFAULT_TOP_LIST,
      ...(wantList ? { list, listFor: preview } : {}),
      defaults: DEFAULTS,
    })
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
    top: DEFAULT_TOP_LIST,
  }))
  const flag = (v: unknown, was: boolean): boolean => (typeof v === 'boolean' ? v : was)
  const style: CommentStyle = {
    emoji: flag(body?.emoji, current.style.emoji),
    splitBrand: flag(body?.splitBrand, current.style.splitBrand),
    quoteBrand: flag(body?.quoteBrand, current.style.quoteBrand),
    voice: isCommentVoice(body?.voice) ? body.voice : current.style.voice,
  }
  // Same rule for the top list: only the keys that were sent are changed, so a
  // save from the length form cannot switch the serving source off.
  const topIn: Partial<TopListSetting> = {}
  if (typeof body?.topEnabled === 'boolean') topIn.enabled = body.topEnabled
  if (body?.topCount !== undefined) topIn.count = Number(body.topCount)
  if (isTopListRank(body?.topRank)) topIn.rank = body.topRank
  if (body?.topDays !== undefined) topIn.days = Number(body.topDays)
  // One per line from the page, or an array.
  if (body?.topAliases !== undefined) {
    topIn.aliases = Array.isArray(body.topAliases)
      ? body.topAliases.map(String)
      : String(body.topAliases ?? '').split(/\r?\n/)
  }
  try {
    await setProductWordBand(product, band)
    await setProductCommentStyle(product, style)
    let top = current.top
    if (Object.keys(topIn).length > 0) {
      try {
        top = await setProductTopList(product, topIn)
      } catch (e) {
        // A spelling that does not fold back to the product: the admin's to fix.
        return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
      }
    }
    // The saved list comes back with the save, so the page never shows a list
    // that belongs to the previous setting.
    const list = top.enabled ? await getTopCommentsForProduct(product, top).catch(() => []) : []
    return NextResponse.json({ ok: true, product, ...band, ...style, top, list })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
