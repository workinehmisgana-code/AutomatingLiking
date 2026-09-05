import { getActiveCommentProducts, pickFairProductForUrl } from './db'
import { getFreshComments } from './commentGen'

/**
 * Choose the comment to serve for one link.
 *
 * Fairness is PER LINK, not global: we look at how many times each product's
 * comment has already been served for this exact URL and pick the least-served
 * one (random among ties). A link that has been advertising one product over and
 * over therefore keeps handing the next turns to the others until they catch up.
 *
 * Picking the product before the comment also removes a second, subtler bias:
 * drawing uniformly from one flattened pool favours whichever product simply has
 * the most comments written for it. Here every product gets an equal shot, then a
 * random comment is taken from within it.
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
