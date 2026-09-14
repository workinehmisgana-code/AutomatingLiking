import { getActiveCommentProducts, pickFairProductForUrl } from './db'
import { getFreshComments } from './commentGen'

/**
 * Choose the comment to serve for one link.
 *
 * The PRODUCT is decided first and is a property of the video, not of this
 * click: whichever of our products already leads that video's comment section
 * gets every further comment on it, so one product dominates rather than four
 * arguing. pickFairProductForUrl holds that rule and the reasoning behind it.
 *
 * Only the COMMENT is random, drawn from within the chosen product. Drawing from
 * one flattened pool instead would also have let whichever product simply has
 * the most comments written for it win the video.
 *
 * Returns nulls when no product is active or the chosen product has no comments,
 * in which case the caller should record the click with no product.
 */
export async function serveCommentForUrl(
  url: string
): Promise<{ product: string | null; comment: string | null }> {
  const products = await getActiveCommentProducts().catch(() => [] as string[])
  if (products.length === 0) return { product: null, comment: null }

  const product = await pickFairProductForUrl(url, products).catch(() => null)
  if (!product) return { product: null, comment: null }

  const { comments } = await getFreshComments(product).catch(() => ({
    comments: [] as string[],
    generatedAt: null,
  }))
  const clean = comments.map((c) => String(c || '').trim()).filter(Boolean)
  if (clean.length === 0) {
    // The product is active but has nothing to say yet — don't attribute the
    // click to it, or it would take a "turn" without a comment being served.
    return { product: null, comment: null }
  }
  return { product, comment: clean[Math.floor(Math.random() * clean.length)] }
}
