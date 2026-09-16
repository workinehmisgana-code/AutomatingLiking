import { activeProductsForPlatform, getLinkCategory, pickFairProductForUrl } from './db'
import { getFreshCategoryComments } from './commentGen'
import {
  FALLBACK_COMMENT_CATEGORY,
  isLinkCategory,
  platformFromUrl,
  type LinkCategory,
} from './config'

/**
 * Choose the comment to serve for one link.
 *
 * The PRODUCT is decided first and is a property of the video, not of this
 * click: whichever of our products already leads that video's comment section
 * gets every further comment on it, so one product dominates rather than four
 * arguing. pickFairProductForUrl holds that rule and the reasoning behind it.
 *
 * It chooses among the products allowed ON THIS LINK'S PLATFORM. A product can
 * be right for one site and wrong for another, and the admin sets that per
 * product; a product absent from the setting is allowed everywhere. The filter
 * comes BEFORE the fair pick, not after, or a video whose leading product is
 * barred here would be handed no comment at all rather than the next product in
 * line.
 *
 * The AUDIENCE is decided by the video too. Comments are written per product AND
 * per audience — "Comments by audience" in the admin — and only those are served:
 * a comment aimed at someone shopping for a rival humanizer has no business under
 * a video about beating Turnitin. A link with NO category falls back to
 * FALLBACK_COMMENT_CATEGORY ('competitors'), which is the guess that is right
 * most often; see the constant for why.
 *
 * Only the COMMENT is random, drawn from within the chosen product and audience.
 * Drawing from one flattened pool instead would also have let whichever product
 * simply has the most comments written for it win the video.
 *
 * If the product that won the video has nothing written for this audience, the
 * OTHER active products are tried for the same audience before giving up. The
 * audience is a property of the video and cannot be substituted; the product is
 * a preference, and a second-choice product beats an empty clipboard. There is
 * no audience-neutral set to fall back on any more, by design.
 *
 * Returns nulls only when no product is active, or when none of them has
 * anything for this audience — in which case the caller should record the click
 * with no product.
 */
export async function serveCommentForUrl(
  url: string
): Promise<{ product: string | null; comment: string | null; category: LinkCategory }> {
  const stored = await getLinkCategory(url).catch(() => null)
  const category: LinkCategory = isLinkCategory(stored) ? stored : FALLBACK_COMMENT_CATEGORY

  const platform = platformFromUrl(url)
  const products = await activeProductsForPlatform(platform).catch(() => [] as string[])
  if (products.length === 0) return { product: null, comment: null, category }

  const first = await pickFairProductForUrl(url, products).catch(() => null)
  if (!first) return { product: null, comment: null, category }

  // The fair pick first, then the rest in their configured order. Each is asked
  // for THIS audience only; getFreshCategoryComments regenerates a stale set on
  // the way.
  const order = [first, ...products.filter((p) => p !== first)]
  for (const product of order) {
    const { comments } = await getFreshCategoryComments(product, category).catch(() => ({
      comments: [] as string[],
      generatedAt: null,
    }))
    const clean = comments.map((c: string) => String(c || '').trim()).filter(Boolean)
    if (clean.length === 0) continue
    return { product, comment: clean[Math.floor(Math.random() * clean.length)], category }
  }
  // Nothing written for this audience by anyone. Don't attribute the click to a
  // product, or one would take a "turn" without a comment being served.
  return { product: null, comment: null, category }
}
