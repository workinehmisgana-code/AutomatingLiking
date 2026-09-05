import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { getActiveCommentProducts } from '@/lib/db'
import { getFreshComments, getFreshCategoryComments } from '@/lib/commentGen'
import { LINK_CATEGORIES, type LinkCategory } from '@/lib/config'

export const dynamic = 'force-dynamic'

// GET — the app's comment POOL.
//
// Comments now come in THREE audience sets (see lib/linkCategory.ts). Each link
// the app receives carries a `category`, and the app copies a comment from the
// matching set, so a comment written for someone worried about Turnitin never
// lands under a video that has nothing to do with detection.
//
// The response stays BACKWARDS COMPATIBLE. `comments` and `commentProducts` keep
// their exact old shape — the flat, every-audience pool — so an app build that
// predates categories behaves exactly as before. `byCategory` is additive and
// simply ignored by those builds.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const products = await getActiveCommentProducts().catch(() => [] as string[])

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

  // The legacy flat pool: every audience merged, de-duped. An older build reads
  // only this and keeps working; a category-aware build ignores it.
  const seen = new Set<string>()
  const comments: string[] = []
  const commentProducts: string[] = []
  for (const category of LINK_CATEGORIES) {
    const list = byCategory[category] ?? []
    const owners = productsByCategory[category] ?? []
    list.forEach((c, i) => {
      if (!seen.has(c)) {
        seen.add(c)
        comments.push(c)
        commentProducts.push(owners[i])
      }
    })
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
    byCategory,
    productsByCategory,
    emptyCategories: empty,
  })
}
