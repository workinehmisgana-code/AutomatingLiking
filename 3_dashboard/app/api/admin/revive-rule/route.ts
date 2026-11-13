import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, PRODUCTS } from '@/lib/config'
import { getActiveCommentProducts, getReviveRule, reviveSet, setReviveRule } from '@/lib/db'
import { loadVideosJson } from '@/lib/videos'
import { ensureGenreRegistry } from '@/lib/genreStore'

export const dynamic = 'force-dynamic'

// The revive rule (lib/db ReviveRule): links opened by many workers that still
// carry none of our comments come back, served one chosen product.
//
//   GET            { rule, products, active, covered }
//   POST { rule }  save it; returns the same

async function admin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

async function state() {
  await ensureGenreRegistry().catch(() => [])
  const [rule, active, videos] = await Promise.all([
    getReviveRule(),
    getActiveCommentProducts().catch(() => [] as string[]),
    loadVideosJson().catch(() => []),
  ])
  // Counted only when on: the pool links it is bringing back right now.
  const covered = rule.enabled ? (await reviveSet(videos as never).catch(() => new Set<string>())).size : 0
  return { rule, products: [...PRODUCTS], active, covered }
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json(await state())
}

export async function POST(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { rule?: unknown }
  try {
    await ensureGenreRegistry().catch(() => [])
    await setReviveRule(body.rule)
    return NextResponse.json({ ok: true, ...(await state()) })
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || String(e) }, { status: 400 })
  }
}
