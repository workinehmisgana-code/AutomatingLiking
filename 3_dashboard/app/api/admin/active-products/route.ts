import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, PRODUCTS, DEACTIVATED_PRODUCTS, isProduct } from '@/lib/config'
import { getActiveCommentProducts, setActiveCommentProducts } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// GET — all products + which are active for the app's comment pool.
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const active = await getActiveCommentProducts()
    return NextResponse.json({
      products: PRODUCTS.filter((p) => !DEACTIVATED_PRODUCTS.includes(p)),
      active,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST { active: string[] } — set the products whose comments feed the app pool.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let active: string[] = []
  try {
    const b = await req.json()
    active = Array.isArray(b?.active) ? b.active.map((x: unknown) => String(x)).filter(isProduct) : []
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  try {
    await setActiveCommentProducts(active)
    return NextResponse.json({ ok: true, active: await getActiveCommentProducts() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
