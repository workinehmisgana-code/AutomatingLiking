// Reading a video's comments to find OUR product comments, and to capture the
// video's own top comment for the reply generator.
//
// Two jobs from one read:
//
//  1. SERVING ORDER. A link already carrying three of our comments is worth less
//     than an untouched one, and a link where our comment sits at position 40 is
//     worth less than one where it sits at position 2. Both are recorded so the
//     cluster can be ordered by them (see lib/servingOrder.ts).
//
//  2. REPLY DRAFTS. The top comment is kept verbatim — usually nothing to do
//     with us — so a reply can be written that answers IT and mentions a product
//     in that context, rather than dropping an unrelated ad under it.

import { fetchComments, type VideoComment } from './linkStats'
import { PRODUCTS, type Product } from './config'

/** Comment pages per link (50 each): enough to place a comment near the top. */
const MAX_PAGES = 4

export interface ProductHit {
  product: Product
  /** 0-based position in the comment list — 0 is the very top. */
  rank: number
  likes: number
  username: string
  text: string
}

export interface ScanResult {
  url: string
  unresolved: boolean
  readCount: number
  totalCount: number | null
  complete: boolean
  ourCount: number
  /** Position of our HIGHEST product comment, or null when none was found. */
  bestRank: number | null
  hits: ProductHit[]
  top: { text: string; username: string; likes: number } | null
}

/**
 * Normalised text for product matching.
 *
 * Product names are single words in practice ("purifytext"), but a commenter may
 * type "Purify Text" or "purify-text", so punctuation and case are stripped
 * before looking for the name.
 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Which of our products a comment mentions. Usually none, sometimes several. */
function productsIn(text: string): Product[] {
  const hay = norm(text)
  if (!hay) return []
  return PRODUCTS.filter((p) => hay.includes(norm(p)))
}

/**
 * Scan one link. Never throws — a dead video must not abort a cluster sweep.
 *
 * `top` is the MOST-LIKED comment we read, not the first one returned. The API's
 * order is not by likes — one sampled video returned likes in the order
 * 2, 1, 1, 1, 1, 1, 1, 78, so taking index 0 picked a 2-like throwaway over the
 * 78-like comment everyone actually reads.
 *
 * Our own product comments are excluded from the choice: replying to our own
 * pitch achieves nothing, and freshly-posted ones often sit near the front.
 */
export async function scanLink(url: string): Promise<ScanResult> {
  const read = await fetchComments(url, MAX_PAGES)
  const base: ScanResult = {
    url,
    unresolved: read.unresolved,
    readCount: read.comments.length,
    totalCount: read.total,
    complete: read.complete,
    ourCount: 0,
    bestRank: null,
    hits: [],
    top: null,
  }
  if (read.unresolved || read.comments.length === 0) return base

  const hits: ProductHit[] = []
  read.comments.forEach((c: VideoComment, i: number) => {
    for (const product of productsIn(c.text)) {
      hits.push({
        product,
        rank: i,
        likes: c.likes,
        username: c.username,
        text: c.text.slice(0, 300),
      })
    }
  })

  // Candidates for "top": everything except our own comments. If a video has
  // nothing but our comments, fall back to all of them rather than storing none.
  const ours = new Set(hits.map((h) => h.rank))
  const candidates = read.comments.filter((_, i) => !ours.has(i))
  const pool = candidates.length > 0 ? candidates : read.comments
  const top = pool.reduce((best, c) => (c.likes > best.likes ? c : best), pool[0])

  return {
    ...base,
    ourCount: hits.length,
    bestRank: hits.length ? Math.min(...hits.map((h) => h.rank)) : null,
    hits,
    top: top ? { text: top.text.slice(0, 500), username: top.username, likes: top.likes } : null,
  }
}

/**
 * Products NOT yet represented on a link.
 *
 * This is what makes rule 3 work: once a link carries a purifytext comment, the
 * next user sent there should be handed a different product's comment, so one
 * video does not end up with five variations of the same pitch.
 */
export function missingProducts(present: string[]): Product[] {
  const has = new Set(present)
  const left = PRODUCTS.filter((p) => !has.has(p))
  // Everything already present means the link is saturated; fall back to the
  // full list rather than returning nothing to serve.
  return left.length > 0 ? left : [...PRODUCTS]
}
