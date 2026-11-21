// WHICH STYLE A COMMENT IS WRITTEN IN, read off its text.
//
// Used to spread styles over ONE LINK (lib/serveComment): a style already
// verified under a video is not handed out there again until every other
// style the product has has been used there too. A video whose comment
// section holds "purify text", "purifytext", "\"purify text\"" and a question
// reads like several people; five of the same shape reads like one.
//
// Read from the text, not stored, because the comments that matter most here
// are the ones the comment scan FOUND on TikTok — those come back as text and
// nothing else. Four things can be read reliably that way:
//
//   quoted    the name in quotation marks              "purify text"
//   split     the name as two words                    purify text / purifytext
//   emoji     an emoji anywhere in it
//   question  it ends as a question (the question and curious voices)
//
// Lookalike letters are folded first (ρυrіfуtеxt is purifytext), since that is
// how a name can be written on the platform.
import { productMatchWords } from './config'
import { fold } from './lookalike'

// Built with the constructor: the project's TypeScript target rejects a /u
// literal, and the Unicode property classes need the flag.
const EMOJI = new RegExp('\\p{Extended_Pictographic}', 'u')
const QUESTION = new RegExp('\\?[\\s\\p{Extended_Pictographic}\\u200d\\ufe0f\\p{Emoji_Modifier}]*$', 'u')

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface StyleSig {
  quoted: boolean
  split: boolean
  emoji: boolean
  question: boolean
}

/** The style of one comment, or null when the product's name is not in it. */
export function readStyle(text: string, product: string): StyleSig | null {
  const raw = String(text ?? '')
  const flat = fold(raw)
  const re = new RegExp(productMatchWords(product).split(' ').map(escapeRe).join('[\\s._-]*'), 'i')
  const m = re.exec(flat)
  if (!m) return null
  const before = flat.slice(0, m.index)
  return {
    quoted: /["'“‘«]\s*$/.test(before),
    split: /[\s._-]/.test(m[0]),
    emoji: EMOJI.test(raw),
    question: QUESTION.test(raw.trim()),
  }
}

/** A short key for a style, e.g. "quoted+split+emoji" or "plain". */
export function styleKey(text: string, product: string): string {
  const s = readStyle(text, product)
  if (!s) return 'unnamed'
  const parts = (['quoted', 'split', 'emoji', 'question'] as const).filter((k) => s[k])
  return parts.length ? parts.join('+') : 'plain'
}

/**
 * Choose among candidate comments so this link gets a style it does not have.
 *
 * `found` are our comments VERIFIED on the link (the comment scan read them
 * there); `served` are ones handed out for it and not yet verified. The style
 * with the fewest verified comments on the link wins; ties go to the fewest
 * served, so the users served between two scans do not all get the same
 * style either. Only when every style the candidates offer is on the link
 * does a style come round again — the least-present one first.
 *
 * Within the winning styles the draw keeps each candidate's own weight (the
 * top list's ratio), so this narrows the choice and never reorders it.
 */
export function pickForLink<T extends { text: string; weight?: number }>(
  candidates: T[],
  product: string,
  found: string[],
  served: string[]
): { pick: T; style: string; fresh: boolean } | null {
  if (candidates.length === 0) return null
  const count = (texts: string[]) => {
    const m = new Map<string, number>()
    for (const t of texts) {
      const k = styleKey(t, product)
      if (k !== 'unnamed') m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }
  const onLink = count(found)
  const handed = count(served)
  const keyed = candidates.map((c) => ({ c, k: styleKey(c.text, product) }))
  let best: [number, number] | null = null
  for (const { k } of keyed) {
    const score: [number, number] = [onLink.get(k) ?? 0, handed.get(k) ?? 0]
    if (!best || score[0] < best[0] || (score[0] === best[0] && score[1] < best[1])) best = score
  }
  const pool = keyed.filter(({ k }) => (onLink.get(k) ?? 0) === best![0] && (handed.get(k) ?? 0) === best![1])
  const total = pool.reduce((n, { c }) => n + Math.max(0, c.weight ?? 1), 0)
  let r = Math.random() * (total || pool.length)
  let chosen = pool[pool.length - 1]
  for (const p of pool) {
    r -= total ? Math.max(0, p.c.weight ?? 1) : 1
    if (r < 0) { chosen = p; break }
  }
  return { pick: chosen.c, style: chosen.k, fresh: best![0] === 0 }
}
