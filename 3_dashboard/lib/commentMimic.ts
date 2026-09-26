// One comment written to match a comment already under the video.
//
// THE OPPOSITE PROBLEM FROM THE COMMENT BANK. A stored comment is written to be
// good anywhere, which is what makes it obviously imported when it lands under a
// video where everyone else is talking about one particular rival tool. The best
// comment on a link like that is the one the thread is already having — the same
// shape, the same register, the same claim — with our product's name where the
// rival's was.
//
// So the liker reads the video's own comments, finds one recommending a rival,
// and sends it here. What comes back is that comment's twin.
//
// WHAT THIS IS NOT. It is not a copy with a word swapped. Handed
// "walterwrites saved my thesis fr", swapping the brand leaves somebody else's
// sentence with our name in it — and the same sentence appearing under fifty
// videos is a pattern a moderator can search for. The model is asked for the
// same KIND of comment, not the same words, and the result goes through the
// same sanitiser as every stored comment: the mention rule, the word band, the
// jargon filter and the cliche filter. A rewrite that fails any of them is
// thrown away and the caller falls back to the bank.
import { groqChat } from './groq'
import { sanitize, settingsFor } from './commentGen'
import { buildMimicPrompt } from './commentPrompt'
import { COMPETITOR_BRANDS } from './linkCategory'
import type { Product } from './config'

/** Is this comment recommending somebody else's tool? */
export function mentionsRival(text: string): string | null {
  const flat = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  for (const brand of COMPETITOR_BRANDS) {
    if (flat.includes(brand)) return brand
  }
  return null
}

/**
 * A comment in the same vein as `sample`, naming `product`.
 *
 * Returns '' when nothing usable came back — a failure here is a reason to post
 * a stored comment instead, never a reason to post something unchecked.
 */
export async function mimicComment(
  product: Product,
  sample: string,
  opts: { timeoutMs?: number } = {}
): Promise<string> {
  const text = String(sample ?? '').trim()
  if (!text) return ''
  const { band, style } = await settingsFor(product)
  const system = buildMimicPrompt(product, band, style)

  // FIVE, and twice if it has to be. The sanitiser throws away most of what a
  // model writes on a bad run — a mention it would not canonicalise, a line
  // four words too long — and the no-rival rule below throws away more: given a
  // comparative sample ("quillbot never worked but stealthwriter does") the
  // model writes comparisons, and every one of them names somebody else's
  // tool. Measured: the first attempt at that sample produced nothing usable
  // three times out of three, so the second attempt says the quiet part loudly.
  const ask = async (strict: boolean) => {
    const { content } = await groqChat({
      temperature: 0.9,
      jsonObject: true,
      maxTokens: band.max * 20 + 200,
      timeoutMs: opts.timeoutMs ?? 30_000,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content:
            `Here is a comment from under the video:\n${JSON.stringify(text)}\n\n` +
            `Write 5 comments of your own in that same vein.` +
            (strict
              ? ` IMPORTANT: your last attempt named another tool. Name NO tool except ` +
                `the one you were told to write about — not even to say it was worse.`
              : ''),
        },
      ],
    })
    try {
      return (JSON.parse(content) as { comments?: unknown })?.comments
    } catch {
      return null
    }
  }

  let clean = sanitize(product, await ask(false), band, { style, banCliches: true })
  let usable = pick(clean, text)
  if (!usable) {
    clean = sanitize(product, await ask(true), band, { style, banCliches: true })
    usable = pick(clean, text)
  }
  return usable
}

/** The first candidate that is neither the sample back nor an advert for a rival. */
function pick(clean: string[], sample: string): string {
  if (!clean.length) return ''

  // THE SAMPLE MUST NOT COME BACK. A model handed one comment and asked for
  // three sometimes returns the original with the brand swapped, which is the
  // one output this must never post.
  const flat = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
  const source = flat(sample)
  // AND IT MUST NOT NAME THE RIVAL. The prompt says so; the model does not
  // always listen. Asked to match "quillbot never worked for me but
  // stealthwriter actually passes turnitin" it wrote "tried quillbot first but
  // prohumanly fixed it" — a good comment that advertises somebody else's tool
  // in our own words, under a video we are trying to win. A rule this important
  // is enforced, not requested.
  const own = clean.filter((c) => flat(c) !== source && !mentionsRival(c))
  return own[0] ?? ''
}
