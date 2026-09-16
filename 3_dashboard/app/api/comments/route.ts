import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { getActiveCommentProducts, getProductPlatforms, isEmailBlocked } from '@/lib/db'
import { getFreshCategoryComments } from '@/lib/commentGen'
import {
  COMMENT_SHUFFLE_MS,
  LINK_CATEGORIES,
  FALLBACK_COMMENT_CATEGORY,
  type LinkCategory,
} from '@/lib/config'

export const dynamic = 'force-dynamic'

// Deterministic shuffle seeded by an integer (same seed → same order).
function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0
  const rand = () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// The data the /comments page needs, loaded client-side so navigation is instant.
//
// ONE POOL PER AUDIENCE. Comments are written per product AND per audience
// ("Comments by audience" in the admin), and those are the only ones served:
// the page copies from the set matching the link the user just opened, so a
// comment aimed at someone shopping for a rival humanizer never lands under a
// video about beating Turnitin. A link with no category of its own uses
// FALLBACK_COMMENT_CATEGORY, which is also what `comments` below is filled from.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(session.user.id)
  if (gate) return gate
  if (await isEmailBlocked(session.user.email).catch(() => false)) {
    return NextResponse.json({ error: 'Account blocked', blocked: true }, { status: 403 })
  }

  // Users are not assigned to a product — they work for all of them. Everyone
  // gets the same cross-product pool the app uses: every ACTIVE product's
  // comments, flattened and de-duped. `productsByCategory` is index-aligned with
  // `byCategory` so the caller can report which product's comment it served.
  const products = await getActiveCommentProducts().catch(() => [] as string[])
  // Which platforms each product may be served on. The page picks its own
  // comment locally (the clipboard write has to happen inside the click
  // handler), so the rule has to travel with the pool rather than being applied
  // server-side as it is for the app. A product absent from the map is allowed
  // everywhere.
  const productPlatforms = await getProductPlatforms().catch(
    () => ({}) as Record<string, string[]>
  )

  // Shuffled on a clock rather than per request, so two tabs of the same page
  // agree and a reload doesn't reshuffle the queue under the user.
  const bucket = Math.floor(Date.now() / COMMENT_SHUFFLE_MS)

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
      const pool: { text: string; product: string }[] = []
      for (let i = 0; i < lists.length; i++) {
        for (const c of lists[i]) {
          const t = String(c || '').trim()
          if (t && !seen.has(t)) {
            seen.add(t)
            pool.push({ text: t, product: products[i] })
          }
        }
      }
      // Shuffle text and product together so they stay paired.
      const shuffled = seededShuffle(pool, bucket)
      byCategory[category] = shuffled.map((c) => c.text)
      productsByCategory[category] = shuffled.map((c) => c.product)
    })
  )

  // The flat pool, for a caller that has no link in hand: the fallback audience,
  // the same set an uncategorised link is served from. Falls through to whatever
  // IS populated rather than returning nothing at all.
  let comments = byCategory[FALLBACK_COMMENT_CATEGORY] ?? []
  let commentProducts = productsByCategory[FALLBACK_COMMENT_CATEGORY] ?? []
  if (comments.length === 0) {
    const stocked = LINK_CATEGORIES.find((c) => (byCategory[c] ?? []).length > 0)
    if (stocked) {
      comments = byCategory[stocked] ?? []
      commentProducts = productsByCategory[stocked] ?? []
    }
  }

  return NextResponse.json({
    product: null,
    pooled: true,
    products,
    comments,
    commentProducts,
    categories: LINK_CATEGORIES,
    fallbackCategory: FALLBACK_COMMENT_CATEGORY,
    productPlatforms,
    byCategory,
    productsByCategory,
    generatedAt: null,
  })
}
