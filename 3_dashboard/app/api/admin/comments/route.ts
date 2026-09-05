import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import {
  isAdminEmail,
  isProduct,
  PRODUCTS,
  DEACTIVATED_PRODUCTS,
  isLinkCategory,
  type Product,
} from '@/lib/config'
import { regenerateProducts, regenerateCategory } from '@/lib/commentGen'

export const dynamic = 'force-dynamic'
// Allow up to ~60s: rewriting several products calls the LLM sequentially.
export const maxDuration = 60

// POST {}                       → regenerate all active products now.
// POST { product }              → regenerate just that product now.
// POST { product, category }    → regenerate ONE product's comments for ONE
//                                 audience (competitors / ai_detector / generic).
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let product: string | null = null
  let category: string | null = null
  try {
    const body = await req.json().catch(() => ({}))
    product = body?.product ? String(body.product) : null
    category = body?.category ? String(body.category) : null
  } catch {
    product = null
  }

  // One audience of one product. Kept separate from the bulk path because it is
  // a single LLM call and reports its own count, so the page can refresh just
  // that panel.
  if (category) {
    if (!product || !isProduct(product)) {
      return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
    }
    if (!isLinkCategory(category)) {
      return NextResponse.json({ error: 'Unknown category' }, { status: 400 })
    }
    try {
      const count = await regenerateCategory(product, category)
      return NextResponse.json({ ok: true, product, category, count })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  let targets: readonly Product[]
  if (product) {
    if (!isProduct(product)) {
      return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
    }
    targets = [product]
  } else {
    targets = PRODUCTS.filter((p) => !DEACTIVATED_PRODUCTS.includes(p))
  }

  try {
    const results = await regenerateProducts(targets)
    return NextResponse.json({ ok: true, results })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
