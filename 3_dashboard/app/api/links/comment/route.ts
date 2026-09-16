import { NextResponse, type NextRequest } from 'next/server'
import { activeProductsForPlatform, getLinkCategory, pickFairProductForUrl } from '@/lib/db'
import { getFreshCategoryComments } from '@/lib/commentGen'
import {
  isProduct,
  isLinkCategory,
  FALLBACK_COMMENT_CATEGORY,
  platformFromUrl,
  type LinkCategory,
} from '@/lib/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// One comment to post on one link, for the liker.
//
// Authenticated with LINKS_EXPORT_TOKEN, the same token the liker already uses
// to pull its links — it runs from the operator's own accounts, not a worker's,
// so it has no app session and there is no user to attribute anything to.
//
// It DOES NOT record a click. The click table drives per-user counts, quotas and
// pay; a liker's comment is none of those, and writing one would inflate a
// worker's numbers with work they did not do. The consequence is that the
// dashboard does not know about the comment until the next "Extract comments"
// scan finds it — which is the honest outcome, and self-correcting.
//
// The comment comes from the link's own AUDIENCE set, the same one the app and
// the web dashboard serve from.
//
//   GET /api/links/comment?token=…&url=…            fair pick, as the app gets
//   GET /api/links/comment?token=…&url=…&product=purifytext   that product

export async function GET(req: NextRequest) {
  const token = process.env.LINKS_EXPORT_TOKEN
  const provided =
    req.nextUrl.searchParams.get('token') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token || provided !== token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = String(req.nextUrl.searchParams.get('url') ?? '').trim()
  if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400 })

  const wanted = String(req.nextUrl.searchParams.get('product') ?? '').trim()
  // Scoped to this link's platform, exactly as the app and the dashboard scope
  // it — the liker posts into the same comment sections.
  const active = await activeProductsForPlatform(platformFromUrl(url)).catch(
    () => [] as string[]
  )

  // An explicitly named product is honoured even when it is switched off for the
  // workers: the caller asked for that one, and silently substituting another
  // would post a comment for a product nobody chose.
  let product: string | null = null
  if (wanted) {
    if (!isProduct(wanted)) {
      return NextResponse.json({ error: `Unknown product: ${wanted}` }, { status: 400 })
    }
    product = wanted
  } else {
    if (active.length === 0) {
      return NextResponse.json(
        { error: `No comment products are active for ${platformFromUrl(url)}` },
        { status: 409 }
      )
    }
    product = await pickFairProductForUrl(url, active).catch(() => null)
  }
  if (!product) return NextResponse.json({ error: 'No product to serve' }, { status: 409 })

  // The audience the link was sorted into decides WHICH comments apply, exactly
  // as it does for the app and the web dashboard — the liker posts into the same
  // comment sections. A link with no category of its own gets
  // FALLBACK_COMMENT_CATEGORY.
  const stored = await getLinkCategory(url).catch(() => null)
  const category: LinkCategory = isLinkCategory(stored) ? stored : FALLBACK_COMMENT_CATEGORY

  const { comments } = await getFreshCategoryComments(product, category).catch(() => ({
    comments: [] as string[],
    generatedAt: null,
  }))
  const clean = comments.map((c: string) => String(c || '').trim()).filter(Boolean)
  if (clean.length === 0) {
    return NextResponse.json(
      { error: `No ${category} comments stored for ${product}` },
      { status: 409 }
    )
  }

  return NextResponse.json({
    ok: true,
    url,
    product,
    category,
    comment: clean[Math.floor(Math.random() * clean.length)],
    pool: clean.length,
  })
}
