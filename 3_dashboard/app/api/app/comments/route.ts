import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { getActiveCommentProducts, getProductPlatforms } from '@/lib/db'
import { getFreshCategoryComments } from '@/lib/commentGen'
import { LINK_CATEGORIES, FALLBACK_COMMENT_CATEGORY, type LinkCategory } from '@/lib/config'

export const dynamic = 'force-dynamic'

// GET — the app's comment POOL.
//
// Comments now come in THREE audience sets (see lib/linkCategory.ts). Each link
// the app receives carries a `category`, and the app copies a comment from the
// matching set, so a comment written for someone worried about Turnitin never
// lands under a video that has nothing to do with detection.
//
// The response stays BACKWARDS COMPATIBLE in SHAPE: `comments` and
// `commentProducts` are still a flat, index-aligned pair, so a build that
// predates categories keeps working. What they CONTAIN has changed — they are
// now the fallback audience's pool rather than every audience merged together.
// A flat pool is used by a caller that cannot tell one link from another, and
// handing that caller a mix of three audiences guarantees two thirds of it is
// aimed at the wrong video. FALLBACK_COMMENT_CATEGORY is the same guess the
// server makes for an uncategorised link; see the constant for why.
//
// `byCategory` is what a current build reads, picking the set that matches each
// link's own `category`.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const products = await getActiveCommentProducts().catch(() => [] as string[])
  // Informational for the app: it pastes the comment the SERVER chose on each
  // click (/api/app/click), and that choice is already scoped to the link's
  // platform. This is here so a build that falls back to its cached pool can
  // apply the same rule instead of ignoring it.
  const productPlatforms = await getProductPlatforms().catch(
    () => ({}) as Record<string, string[]>
  )

  // One flat pool per audience, plus the product each comment belongs to. The
  // product mapping is what per-product click attribution counts, so it has to
  // survive the split.
  const byCategory: Record<string, string[]> = {}
  const productsByCategory: Record<string, string[]> = {}

  await Promise.all(
    LINK_CATEGORIES.map(async (category: LinkCategory) => {
      const lists = await Promise.all(
        products.map((p) =>
          getFreshCategoryComments(p, category)
            .then((r) => r.comments)
            .catch(() => [] as string[])
        )
      )
      const seen = new Set<string>()
      const comments: string[] = []
      const owners: string[] = []
      for (let i = 0; i < lists.length; i++) {
        for (const c of lists[i]) {
          const s = String(c || '').trim()
          if (s && !seen.has(s)) {
            seen.add(s)
            comments.push(s)
            owners.push(products[i])
          }
        }
      }
      byCategory[category] = comments
      productsByCategory[category] = owners
    })
  )

  // The flat pool: the fallback audience, which is the one to use when the
  // link's audience is unknown — and to a caller reading this field, every
  // link's audience is unknown. Falls back to whatever IS populated rather than
  // handing back an empty list.
  let comments = byCategory[FALLBACK_COMMENT_CATEGORY] ?? []
  let commentProducts = productsByCategory[FALLBACK_COMMENT_CATEGORY] ?? []
  if (comments.length === 0) {
    const stocked = LINK_CATEGORIES.find((c) => (byCategory[c] ?? []).length > 0)
    if (stocked) {
      comments = byCategory[stocked] ?? []
      commentProducts = productsByCategory[stocked] ?? []
    }
  }
  // A build that knows about categories but finds one empty should fall back to
  // the flat pool rather than copy nothing.
  const empty = LINK_CATEGORIES.filter((c) => (byCategory[c] ?? []).length === 0)

  return NextResponse.json({
    product: null,
    pooled: true,
    products,
    comments,
    commentProducts,
    categories: LINK_CATEGORIES,
    // Which set `comments` above was filled from, and what a link with no
    // category of its own should use.
    fallbackCategory: FALLBACK_COMMENT_CATEGORY,
    productPlatforms,
    byCategory,
    productsByCategory,
    emptyCategories: empty,
  })
}
