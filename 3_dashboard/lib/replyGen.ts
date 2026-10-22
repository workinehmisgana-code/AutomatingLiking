// Writing replies to a video's TOP comment.
//
// Two different jobs, decided by what the comment says:
//
//  RECOMMEND — the usual case. The top comment has nothing to do with us
//    ("this saved my GPA 😭", "wait how does this work"). Dropping a product
//    pitch under it reads as spam, so the reply answers the comment first and
//    names the product as the reason it worked.
//
//  AFFIRM — the comment ALREADY mentions one of our products. Pitching at
//    someone who just recommended us is worse than saying nothing: it reads as
//    a bot, and it argues with a happy customer. A short agreement is the whole
//    reply, and it affirms the product THEY named, never a different one.
//
// Drafts only. Nothing is posted from here — the admin reviews them on
// /admin/replies and copies the ones worth using.

import { llmChat } from './llm'
import { PRODUCTS, DEACTIVATED_PRODUCTS, genreOfProduct, type Product } from './config'
import { REPLY_AFFIRM as AFFIRM, REPLY_RECOMMEND as RECOMMEND } from './prompts'
import type { WordBand } from './db'

export interface ReplyTarget {
  url: string
  topText: string
  topUser: string | null
}

export interface ReplyDraft {
  url: string
  topText: string
  topUser: string | null
  product: string
  reply: string
}

/** A comment judged not to be about humanizers or AI detection. */
export interface ReplySkip {
  url: string
  topText: string
}

/** One prompt's worth. Small enough that a misaligned array is cheap to redo. */
export const CHUNK = 8

/** Replies shorter than this cannot both answer a comment and name a product. */
export const REPLY_WORD_MIN = 8
export const REPLY_WORD_MAX = 22

/** Active products, so drafts never advertise something switched off. */
export function activeProducts(): Product[] {
  const live = PRODUCTS.filter((p) => !DEACTIVATED_PRODUCTS.includes(p))
  return live.length > 0 ? live : [...PRODUCTS]
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The product a comment already names, if any. */
export function productMentioned(text: string): Product | null {
  const hay = norm(text)
  if (!hay) return null
  return PRODUCTS.find((p) => hay.includes(norm(p))) ?? null
}

/** The model's "not relevant" verdict, allowing trailing punctuation. */
const SKIP_RE = /^skip\b/i

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Keep only replies that obey the rules. Same idea as the comment generator's
 * sanitize: the model is asked for constraints, not trusted to honour them.
 *
 * The word check allows a little slack around the band — a reply one word over
 * is still usable, and rejecting it just wastes the call — but not unbounded.
 */
function usable(reply: unknown, product: string, band: WordBand): string | null {
  if (typeof reply !== 'string') return null
  const s = reply.trim().replace(/^["'\s]+|["'\s]+$/g, '')
  if (!s) return null
  if (!s.toLowerCase().includes(product.toLowerCase())) return null
  if (/[#@]/.test(s)) return null
  const n = wordCount(s)
  if (n < Math.max(2, band.min - 2) || n > band.max + 2) return null
  return s
}

/** One prompt for one mode. Never throws; a failed call yields no drafts. */
async function runMode(
  mode: 'recommend' | 'affirm',
  items: { url: string; topText: string; topUser: string | null; product: Product }[],
  band: WordBand
): Promise<{ drafts: ReplyDraft[]; skips: ReplySkip[] }> {
  if (items.length === 0) return { drafts: [], skips: [] }

  // ONE CALL PER GENRE. The relevance test in the system prompt is specific to
  // what the product is — "is this comment about AI detection" versus "is this
  // comment about getting a website made" — and a batch can hold items for
  // several products. Split first, then each call carries the right test.
  //
  // Recursion rather than a loop so everything below stays exactly as it was,
  // handling one genre's items with one genre's prompt.
  const genres = Array.from(new Set(items.map((t) => genreOfProduct(t.product))))
  if (genres.length > 1) {
    const parts = await Promise.all(
      genres.map((g) =>
        runMode(mode, items.filter((t) => genreOfProduct(t.product) === g), band)
      )
    )
    return {
      drafts: parts.flatMap((p) => p.drafts),
      skips: parts.flatMap((p) => p.skips),
    }
  }
  // Every item here is one genre, so any of their products answers for it.
  const genreProduct = items[0].product

  const list = items
    .map(
      (t, i) =>
        `${i + 1}. product: ${t.product} | comment: ${t.topText.slice(0, 220).replace(/\s+/g, ' ')}`
    )
    .join('\n')
  try {
    const { content } = await llmChat({
      temperature: mode === 'affirm' ? 0.7 : 0.85,
      jsonObject: true,
      // Scaled to the batch and the word band, not fixed. A fixed 1200 was
      // enough for a few short replies but truncated a batch of ten mid-JSON,
      // and Groq rejects the whole call as invalid JSON rather than returning
      // the part it managed — so the entire chunk yielded nothing.
      maxTokens: Math.min(4000, 400 + items.length * (band.max * 4 + 40)),
      messages: [
        {
          role: 'system',
          content: mode === 'affirm' ? AFFIRM(band) : RECOMMEND(band, genreProduct),
        },
        { role: 'user', content: `Write one reply for each:\n${list}` },
      ],
    })
    const parsed = JSON.parse(content) as { replies?: unknown }
    const arr = Array.isArray(parsed.replies) ? parsed.replies : []
    const drafts: ReplyDraft[] = []
    const skips: ReplySkip[] = []
    items.forEach((t, i) => {
      const raw = arr[i]
      if (typeof raw === 'string' && SKIP_RE.test(raw.trim())) {
        skips.push({ url: t.url, topText: t.topText })
        return
      }
      const reply = usable(raw, t.product, band)
      if (reply) {
        drafts.push({ url: t.url, topText: t.topText, topUser: t.topUser, product: t.product, reply })
      }
      // Anything else — malformed, or a reply that broke the rules — is left
      // alone so the next run retries it, rather than being recorded as a false
      // "unrelated" that would never be looked at again.
    })
    return { drafts, skips }
  } catch {
    return { drafts: [], skips: [] }
  }
}

/**
 * Draft one reply per target, splitting them by mode.
 *
 * Products are assigned round-robin for the RECOMMEND group so one run does not
 * write every reply for the same product. The AFFIRM group has no choice — it
 * must use the product the commenter named.
 */
export async function draftReplies(
  targets: ReplyTarget[],
  band: WordBand = { min: REPLY_WORD_MIN, max: REPLY_WORD_MAX },
  /**
   * The genre these links are in. Round-robin used to run over EVERY active
   * product, so a website-builder video could be drafted a reply recommending
   * a humanizer. With a genre, only its products are recommended, and a
   * comment naming another genre's product is recommended to rather than
   * affirmed.
   */
  genre?: string
): Promise<{ drafts: ReplyDraft[]; skips: ReplySkip[] }> {
  if (targets.length === 0) return { drafts: [], skips: [] }
  const all = activeProducts()
  const inGenre = genre ? all.filter((p) => genreOfProduct(p) === genre) : all
  const products = inGenre.length > 0 ? inGenre : all

  const affirm: { url: string; topText: string; topUser: string | null; product: Product }[] = []
  const recommend: typeof affirm = []
  let i = 0
  for (const t of targets) {
    const named = productMentioned(t.topText)
    if (named && (!genre || genreOfProduct(named) === genre)) {
      affirm.push({ ...t, product: named })
    } else {
      recommend.push({ ...t, product: products[i % products.length] })
      i++
    }
  }

  // Sequential: two concurrent calls for the same run hit the Groq per-minute
  // token limit and the second just fails.
  const a = await runMode('affirm', affirm, band)
  const r = await runMode('recommend', recommend, band)
  return { drafts: [...a.drafts, ...r.drafts], skips: [...a.skips, ...r.skips] }
}
