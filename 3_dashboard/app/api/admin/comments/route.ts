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
import {
  regenerateCategoryProducts,
  regenerateCategory,
  appendToCategory,
} from '@/lib/commentGen'
import { deleteCategoryComment, setCategoryVoices } from '@/lib/db'

export const dynamic = 'force-dynamic'
// Allow up to ~60s: rewriting several products calls the LLM sequentially.
export const maxDuration = 60

// Comments exist per PRODUCT and per AUDIENCE, and nowhere else — every route
// here therefore names an audience, or means "all three of them".
//
// DELETE { product, category, text } → drop one comment from that audience's set.
//
// POST {}                                  → regenerate all three audiences of
//                                            every active product.
// POST { product }                         → all three audiences of that product.
// POST { product, category }               → just that one audience.
// POST { product, category, append: true } → ADD another batch to that audience,
//                                            in the voice currently set, keeping
//                                            what is already there.
// POST { product, category, voices: [] }   → set the VOICES that audience is
//                                            rebuilt from. The comments already
//                                            written are left alone.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let product: string | null = null
  let category: string | null = null
  let append = false
  // Present only on a recipe edit. Read here with the rest of the body, because
  // the body is not in scope below.
  let voices: unknown[] | null = null
  try {
    const body = await req.json().catch(() => ({}))
    product = body?.product ? String(body.product) : null
    category = body?.category ? String(body.category) : null
    append = body?.append === true
    voices = Array.isArray(body?.voices) ? (body.voices as unknown[]) : null
  } catch {
    product = null
  }

  // Edit the recipe without touching the text. Checked before `append` and
  // before the regenerate paths, because it is the only one that generates
  // nothing at all.
  if (voices !== null) {
    if (!product || !isProduct(product)) {
      return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
    }
    if (!isLinkCategory(category)) {
      return NextResponse.json({ error: 'Unknown audience' }, { status: 400 })
    }
    const wanted = voices.map((v) => String(v))
    if (wanted.length === 0) {
      // An empty recipe would silently fall back to the current voice, which is
      // not what "remove every voice" looks like it should do.
      return NextResponse.json({ error: 'A set needs at least one voice.' }, { status: 400 })
    }
    try {
      const saved = await setCategoryVoices(product, category, wanted)
      if (saved.length === 0) {
        return NextResponse.json({ error: 'None of those voices are known.' }, { status: 400 })
      }
      return NextResponse.json({ ok: true, product, category, voices: saved })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // ADD to an audience's set rather than replacing it, so a set can be built
  // from more than one voice. The voice used is whatever is set right now —
  // switching it and pressing Add again is how a mix is made.
  if (append) {
    if (!product || !isProduct(product)) {
      return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
    }
    if (!isLinkCategory(category)) {
      return NextResponse.json({ error: 'Unknown audience' }, { status: 400 })
    }
    try {
      const { added, total } = await appendToCategory(product, category)
      return NextResponse.json({ ok: true, product, category, added, total })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
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
    // Every audience of every target. Sequential inside, because concurrent
    // rewrites of one product exhaust the Groq tokens-per-minute budget.
    const results = await regenerateCategoryProducts(targets)
    return NextResponse.json({ ok: true, results })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// Remove ONE comment an admin does not want, by its exact text.
//
// By text rather than position: the page can be a regeneration behind the
// stored set, and deleting "number 7" would then drop whatever is seventh now.
// A string that no longer matches removes nothing and says so, which is the
// right outcome when the two have diverged.
export async function DELETE(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    product?: unknown
    category?: unknown
    text?: unknown
  }
  const product = String(body.product ?? '')
  const text = String(body.text ?? '')
  if (!isProduct(product)) return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
  if (!text) return NextResponse.json({ error: 'No comment given' }, { status: 400 })

  const category = String(body.category ?? '')
  if (!isLinkCategory(category)) {
    return NextResponse.json({ error: 'Unknown audience' }, { status: 400 })
  }
  try {
    const removed = await deleteCategoryComment(product, category, text)
    return NextResponse.json({ ok: true, removed, category })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
