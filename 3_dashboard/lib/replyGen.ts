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

import { groqChat } from './groq'
import { PRODUCTS, DEACTIVATED_PRODUCTS, type Product } from './config'
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

function rules(band: WordBand): string {
  return (
    `- be ${band.min} to ${band.max} words, lowercase, casual, like a real person replying on ` +
    'their phone.\n' +
    '- contain NO hashtags, NO emojis, NO quotes, NO @mentions.\n' +
    '- never claim to be the video author and never insult the commenter.\n'
  )
}

// The relevance test, shared by both prompts. A reply only belongs under a
// comment whose author is already thinking about AI writing or getting caught —
// anywhere else it is an advert nobody asked for, which is what gets accounts
// restricted.
const RELEVANCE =
  'ONLY reply when the comment is about AI WRITING or AI DETECTION: humanizers, paraphrasers, ' +
  '"bypass AI", Turnitin, GPTZero and other detectors, being flagged or caught, ' +
  'ChatGPT-written essays, or how to make AI text sound human.\n' +
  'If the comment is about ANYTHING ELSE — general study talk, the creator, jokes, unrelated ' +
  'questions, abuse, spam — return exactly "SKIP" for that item instead of a reply. Do not ' +
  'stretch to make something relevant: when in doubt, SKIP.\n'

const RECOMMEND = (band: WordBand) =>
  'You write REPLIES to comments under short study/AI videos on TikTok.\n' +
  RELEVANCE +
  'When you do reply, it must:\n' +
  "- answer or react to the comment it replies to, in that comment's own terms. If the comment " +
  'asks something, answer it. If it complains, sympathise. Never ignore what it says.\n' +
  '- then mention the given product by name, once, as the thing that helped — a humanizer that ' +
  'rewrites AI text so it reads as human and passes AI detectors.\n' +
  rules(band) +
  'Return STRICT JSON {"replies":[...]} — one string per item, SAME ORDER, exactly as many ' +
  'entries as items. Use "SKIP" for items you are not replying to.'

const AFFIRM = (band: WordBand) =>
  'You write short REPLIES agreeing with comments that already recommend a product.\n' +
  'The commenter has just named the product themselves and is happy with it. Your reply must:\n' +
  '- simply AGREE with them. Second their experience, nothing more.\n' +
  '- mention the SAME product they named, once.\n' +
  '- NOT pitch, NOT list features, NOT explain what it does, NOT try to convince anyone. They ' +
  'are already convinced. Anything salesy here reads as a bot.\n' +
  rules(band) +
  'If a comment only mentions the product in passing and is really about something else ' +
  'entirely, return exactly "SKIP" for it instead.\n' +
  'Return STRICT JSON {"replies":[...]} — one string per item, SAME ORDER, exactly as many ' +
  'entries as items.'

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
  const list = items
    .map(
      (t, i) =>
        `${i + 1}. product: ${t.product} | comment: ${t.topText.slice(0, 220).replace(/\s+/g, ' ')}`
    )
    .join('\n')
  try {
    const { content } = await groqChat({
      temperature: mode === 'affirm' ? 0.7 : 0.85,
      jsonObject: true,
      // Scaled to the batch and the word band, not fixed. A fixed 1200 was
      // enough for a few short replies but truncated a batch of ten mid-JSON,
      // and Groq rejects the whole call as invalid JSON rather than returning
      // the part it managed — so the entire chunk yielded nothing.
      maxTokens: Math.min(4000, 400 + items.length * (band.max * 4 + 40)),
      messages: [
        { role: 'system', content: mode === 'affirm' ? AFFIRM(band) : RECOMMEND(band) },
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
  band: WordBand = { min: REPLY_WORD_MIN, max: REPLY_WORD_MAX }
): Promise<{ drafts: ReplyDraft[]; skips: ReplySkip[] }> {
  if (targets.length === 0) return { drafts: [], skips: [] }
  const products = activeProducts()

  const affirm: { url: string; topText: string; topUser: string | null; product: Product }[] = []
  const recommend: typeof affirm = []
  let i = 0
  for (const t of targets) {
    const named = productMentioned(t.topText)
    if (named) {
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
