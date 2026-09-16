import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import {
  isAdminEmail,
  PRODUCTS,
  DEACTIVATED_PRODUCTS,
  isProduct,
  CLICK_PLATFORMS,
} from '@/lib/config'
import {
  getActiveCommentProducts,
  setActiveCommentProducts,
  getProductPlatforms,
  setProductPlatforms,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// GET — all products, which are active, and which platforms each may be served
// on. A product absent from `platforms` is allowed everywhere.
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const [active, platforms] = await Promise.all([
      getActiveCommentProducts(),
      getProductPlatforms().catch(() => ({}) as Record<string, string[]>),
    ])
    return NextResponse.json({
      products: PRODUCTS.filter((p) => !DEACTIVATED_PRODUCTS.includes(p)),
      active,
      platforms,
      allPlatforms: CLICK_PLATFORMS,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST { active: string[] }             the products whose comments are served
// POST { platforms: { product: [] } }   which platforms each may be served on
//
// Two separate writes, because they answer different questions and one must not
// silently reset the other: a request that carries only `platforms` leaves the
// active list exactly as it was.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    if (b?.platforms && typeof b.platforms === 'object' && !Array.isArray(b.platforms)) {
      const saved = await setProductPlatforms(b.platforms as Record<string, string[]>)
      return NextResponse.json({ ok: true, platforms: saved })
    }
    const active = Array.isArray(b?.active)
      ? (b.active as unknown[]).map((x) => String(x)).filter(isProduct)
      : []
    await setActiveCommentProducts(active)
    return NextResponse.json({ ok: true, active: await getActiveCommentProducts() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
