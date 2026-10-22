import {
  activeProductsForPlatform,
  getLinkCategory,
  pickFairProductForUrl,
  getProductCommentSettings,
  getTopCommentsForProduct,
} from './db'
import { COMMENT_WORD_MIN, COMMENT_WORD_MAX } from './config'
import { getFreshCategoryComments } from './commentGen'
import {
  DEFAULT_GENRE,
  fallbackCategory,
  isLinkCategory,
  platformFromUrl,
  productsInGenre,
  type LinkCategory,
} from './config'
import { genreOfUrl } from './videos'

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
 * THE TOP LIST OVERRIDES ALL OF THAT, per product, when the admin turns it on.
 * Then the comment comes from the few that have measurably been landing — the
 * product's own comments over a recent window, ranked by reach, by yield or by
 * both — rather than from what was written for this audience.
 *
 * It is a real trade and it is made deliberately: the bank is written PER
 * AUDIENCE and the top list is not, so this serves what works at the cost of
 * matching the comment to the video. An empty list (nothing measured yet, or a
 * window with nothing in it) falls back to the bank rather than serving nothing,
 * because a click with no comment is worse than a less targeted one.
 *
 * Returns nulls only when no product is active, or when none of them has
 * anything for this audience — in which case the caller should record the click
 * with no product.
 */
export async function serveCommentForUrl(
  url: string
): Promise<{ product: string | null; comment: string | null; category: LinkCategory }> {
  // The genre first: it decides which products may be served AND which audience
  // an uncategorised link falls back to. A website link has never been through
  // the classifier — see fallbackCategory — so without this it would fall back
  // to 'competitors', and be served a comment written for somebody shopping for
  // a rival humanizer.
  const genre = await genreOfUrl(url).catch(() => DEFAULT_GENRE)
  const stored = await getLinkCategory(url).catch(() => null)
  const category: LinkCategory = isLinkCategory(stored) ? stored : fallbackCategory(genre)

  const platform = platformFromUrl(url)
  const allowed = await activeProductsForPlatform(platform).catch(() => [] as string[])

  // ── THE GENRE IS A WALL, NOT A PREFERENCE ──────────────────────────
  //
  // Narrowed HERE, before the fair pick and before the fallback loop below, for
  // the same reason the platform filter is: a product excluded after the pick
  // would leave the video with no comment at all instead of the next one in
  // line.
  //
  // And unlike the platform filter, this one must never be relaxed. The loop
  // below tries the OTHER active products when the winning one has nothing
  // written for this audience — which across genres means handing a humanizer
  // comment to a website-builder video the first time cocodly's bank is thin.
  // That is not a weaker advert; it is a stranger talking about something else,
  // under a video whose viewers were never ours.
  //
  // So a genre with nothing written returns no comment, and the click is
  // recorded with no product. An empty clipboard is the right answer here.
  const inGenre = new Set(productsInGenre(genre))
  const products = allowed.filter((p) => inGenre.has(p))
  if (products.length === 0) return { product: null, comment: null, category }

  const first = await pickFairProductForUrl(url, products).catch(() => null)
  if (!first) return { product: null, comment: null, category }

  // The fair pick first, then the rest in their configured order. Each is asked
  // for THIS audience only; getFreshCategoryComments regenerates a stale set on
  // the way.
  const order = [first, ...products.filter((p) => p !== first)]
  for (const product of order) {
    // The measured list first, when this product is set to use one.
    const { top } = await getProductCommentSettings(product, {
      min: COMMENT_WORD_MIN,
      max: COMMENT_WORD_MAX,
    }).catch(() => ({ top: { enabled: false, count: 20, rank: 'balanced' as const, days: 30 } }))
    if (top.enabled) {
      const best = await getTopCommentsForProduct(product, top).catch(() => [])
      const pool = best.map((b) => b.text.trim()).filter(Boolean)
      if (pool.length > 0) {
        return { product, comment: pool[Math.floor(Math.random() * pool.length)], category }
      }
      // Nothing measured yet for this product in this window — the bank below.
    }
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
