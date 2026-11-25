import { applyProductAlias } from './lookalike'
import {
  activeProductsForPlatform,
  applyReviveRule,
  getLinkCategory,
  pickFairProductForUrl,
  getProductCommentSettings,
  getTopCommentsForProduct,
  getLinkCommentTexts,
  getProductCountsForUrl,
} from './db'
import { canonicaliseMention } from './commentGen'
import { pickForLink } from './commentStyleSig'
import { COMMENT_WORD_MIN, COMMENT_WORD_MAX, DEFAULT_TOP_LIST, DEFAULT_COMMENT_STYLE } from './config'
import { getFreshCategoryComments } from './commentGen'
import { cached } from './poolCache'
import { productsWithComments } from './db'
import {
  CLICK_PLATFORMS as PLATFORMS,
  GENRES,
  DEFAULT_GENRE,
  fallbackCategory,
  isLinkCategory,
  platformFromUrl,
  productsInGenre,
  type LinkCategory,
} from './config'
import { genreOfUrl } from './videos'
import { pickRedditComment } from './redditComments'
import type { Product } from './config'

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
  const { category, order } = await productOrderForUrl(url)
  if (order.length === 0) return { product: null, comment: null, category }

  // ── REDDIT: a comment written for THIS post (lib/redditComments) ──
  // Ahead of the top list and the bank: a Reddit thread is read, and a comment
  // that does not answer the post is spotted. Only the winning product is
  // tried — a failure here means the model is unreachable, and asking again for
  // the next product would only double the wait before the bank below.
  let out: { product: string | null; comment: string | null; category: LinkCategory } | null = null
  if (platformFromUrl(url) === 'reddit') {
    const product = order[0]
    const comment = await pickRedditComment(url, product as Product).catch(() => null)
    if (comment) out = { product, comment, category }
  }
  out = out ?? (await serveFromBank(order, category, url))
  if (out.product && out.comment) {
    out = { ...out, comment: await nameForLink(out.comment, out.product, url) }
  }
  return out
}

/**
 * WHICH LINKS HAVE A COMMENT TO GIVE, by genre and platform.
 *
 * A link is only worth handing a worker if a comment comes with it. When a
 * genre's links were in the feed before its product had a single comment
 * written (AI models hub, 2026-11-24 16:00 → 11-25 07:30), 531 clicks were
 * served nothing and the app pasted "null" under the videos.
 *
 * So the feeds ask this first: some product of the link's genre must be active
 * on the link's platform AND have something to serve — a measured top list, or
 * comments in its bank. Reddit needs only the active product, because a Reddit
 * post gets comments written for it on the first click (lib/redditComments).
 *
 * Per genre and platform, not per link: a per-link answer would mean reading
 * the category of 150k links on every load. The finer causes of an empty serve
 * (one audience unwritten, the revive rule) are left to serveCommentReliably.
 *
 * Cached for a minute; anything that fails to read counts as "can serve", so a
 * database hiccup never empties everybody's list.
 */
export function commentCoverage(): Promise<(genre: string, url: string) => boolean> {
  return cached('commentCoverage', 60_000, async () => {
    const active: Record<string, string[] | null> = {}
    for (const p of PLATFORMS) {
      active[p] = await activeProductsForPlatform(p).catch(() => null)
    }
    const banked = await productsWithComments().catch(() => null)
    const ready = new Map<string, boolean>()
    const hasSomething = async (product: string): Promise<boolean> => {
      if (ready.has(product)) return ready.get(product)!
      let ok = banked === null || banked.has(product)
      if (!ok) {
        const { top } = await getProductCommentSettings(product, {
          min: COMMENT_WORD_MIN,
          max: COMMENT_WORD_MAX,
        }).catch(() => ({ top: DEFAULT_TOP_LIST }))
        ok = top.enabled
          ? (await getTopCommentsForProduct(product, top).catch(() => [{ text: 'x' }])).length > 0
          : false
      }
      ready.set(product, ok)
      return ok
    }
    // genre|platform -> can serve
    const table = new Map<string, boolean>()
    for (const p of PLATFORMS) {
      const on = active[p]
      for (const g of GENRES) {
        if (on === null) {
          table.set(`${g}|${p}`, true)
          continue
        }
        const candidates = productsInGenre(g).filter((x) => on.includes(x))
        let ok = false
        for (const c of candidates) {
          if (p === 'reddit' || (await hasSomething(c))) {
            ok = true
            break
          }
        }
        table.set(`${g}|${p}`, ok)
      }
    }
    return (genre: string, url: string) => table.get(`${genre}|${platformFromUrl(url)}`) ?? true
  }).catch(() => () => true)
}

/**
 * serveCommentForUrl, asked again when it comes back empty.
 *
 * Every read inside it swallows its own error, and a failed read of the active
 * products or of the fair pick looks exactly like "no product may be served":
 * the click is recorded with nothing and the worker is handed no comment. From
 * the outside, a database or blob hiccup is indistinguishable from a rule. So
 * an empty answer is asked again, RETRIES more times, before it is believed.
 * (Links whose genre has nothing to serve at all are kept out of the feeds by
 * commentCoverage, so these retries are not spent on a certain no.)
 */
const RETRIES = 5

export async function serveCommentReliably(
  url: string
): Promise<{ product: string | null; comment: string | null }> {
  let last: { product: string | null; comment: string | null } | null = null
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, 250 * attempt))
    const r = await serveCommentForUrl(url).catch((e) => {
      console.warn('[serveComment] failed for', url, String(e))
      return null
    })
    if (r?.product && r.comment) return r
    if (r) last = r
  }
  if (last) return last
  console.warn('[serveComment] no comment for', url)
  return { product: null, comment: null }
}

/**
 * THE NAME'S FORM, DECIDED BY THE LINK (CommentStyle.linkAware, on unless the
 * product turns it off on the Comments page).
 *
 * The first comment of ours on a video writes the name quoted and split —
 * "purify text" — and every later one joined and plain: purifytext. "Ours"
 * is ANY of our products, verified on the video by the comment scan or
 * already handed out for it (getProductCountsForUrl): counting only verified
 * ones would let every worker who opens a fresh link before the next scan
 * post the quoted first comment.
 *
 * Applied to whatever comment was chosen, so it holds whatever the stored set
 * looks like. A comment where the name cannot be found as written (an admin
 * alias in lookalike letters) is left exactly as it is.
 */
async function nameForLink(comment: string, product: string, url: string): Promise<string> {
  const { style } = await getProductCommentSettings(product, { min: COMMENT_WORD_MIN, max: COMMENT_WORD_MAX })
    .catch(() => ({ style: DEFAULT_COMMENT_STYLE }))
  if (style.linkAware === false) return comment
  const counts = await getProductCountsForUrl(url).catch(() => null)
  if (counts === null) return comment // unknown: leave the comment as written
  return formNameForLink(comment, product, Object.values(counts).every((n) => !n))
}

/** The comment with its name written for the first comment on a link
 *  ("purify text") or a later one (purifytext). Unchanged if the name
 *  cannot be found as written. */
export function formNameForLink(comment: string, product: string, first: boolean): string {
  const formed = canonicaliseMention(comment, product as Product, {
    ...DEFAULT_COMMENT_STYLE,
    quoteBrand: first,
    splitBrand: first,
    mix: [],
  })
  return formed ?? comment
}

/**
 * Which products may be served on this link, the fair pick first, and the
 * audience it is served for. [] when none may.
 */
export async function productOrderForUrl(
  url: string
): Promise<{ category: LinkCategory; order: string[] }> {
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
  // And the revive rule (lib/db ReviveRule) — here as well as in the fair pick,
  // so the fallback loop below cannot hand a covered link to another product,
  // or a reserved product to a link it does not cover.
  const products = await applyReviveRule(
    url,
    allowed.filter((p) => inGenre.has(p))
  ).catch(() => allowed.filter((p) => inGenre.has(p)))
  if (products.length === 0) return { category, order: [] }

  const first = await pickFairProductForUrl(url, products).catch(() => null)
  if (!first) return { category, order: [] }

  // The fair pick first, then the rest in their configured order.
  return { category, order: [first, ...products.filter((p) => p !== first)] }
}

/** The top list or the audience bank, product by product. Each is asked for
 *  THIS audience only; getFreshCategoryComments regenerates a stale set on the way. */
async function serveFromBank(
  order: string[],
  category: LinkCategory,
  url = ''
): Promise<{ product: string | null; comment: string | null; category: LinkCategory }> {
  // A DIFFERENT STYLE ON EACH LINK. What of this product is already under the
  // video — verified by the comment scan, or handed out and not yet verified —
  // so a style already there is not served again until the product's other
  // styles have been used on it too (lib/commentStyleSig pickForLink). A read
  // that fails just means no preference: serving goes on as before.
  const onLink = async (product: string) =>
    url ? await getLinkCommentTexts(url, product).catch(() => ({ found: [], served: [] }))
        : { found: [] as string[], served: [] as string[] }
  for (const product of order) {
    // The measured list first, when this product is set to use one.
    const { top, style } = await getProductCommentSettings(product, {
      min: COMMENT_WORD_MIN,
      max: COMMENT_WORD_MAX,
    }).catch(() => ({ top: DEFAULT_TOP_LIST, style: DEFAULT_COMMENT_STYLE }))
    // With the link deciding the name's form (nameForLink), quoting and
    // splitting are not styles to rotate: only the rest are.
    const ignore = style.linkAware !== false ? (['quoted', 'split'] as const) : []
    if (top.enabled) {
      const best = (await getTopCommentsForProduct(product, top).catch(() => [])).filter((b) =>
        b.text.trim()
      )
      if (best.length > 0) {
        // DRAWN BY RATIO, not evenly: each comment's chance is the share the
        // list shows beside it (topServeChances), so what lands more often is
        // served more often — among the styles this link does not have yet.
        const { found, served } = await onLink(product)
        const chosen = pickForLink(best.map((b) => ({ ...b, weight: b.chance })), product, found, served, ignore)
        const pick = chosen?.pick ?? best[0]
        let comment = pick.text.trim()
        // Written under one of the admin's spellings of the name, when set.
        if (top.aliases.length > 0) {
          const alias = top.aliases[Math.floor(Math.random() * top.aliases.length)]
          comment = applyProductAlias(comment, product, alias)
        }
        return { product, comment, category }
      }
      // Nothing measured yet for this product in this window — the bank below.
    }
    const { comments } = await getFreshCategoryComments(product, category).catch(() => ({
      comments: [] as string[],
      generatedAt: null,
    }))
    const clean = comments.map((c: string) => String(c || '').trim()).filter(Boolean)
    if (clean.length === 0) continue
    const { found, served } = await onLink(product)
    const chosen = pickForLink(clean.map((text) => ({ text })), product, found, served, ignore)
    return { product, comment: chosen?.pick.text ?? clean[Math.floor(Math.random() * clean.length)], category }
  }
  // Nothing written for this audience by anyone. Don't attribute the click to a
  // product, or one would take a "turn" without a comment being served.
  return { product: null, comment: null, category }
}
