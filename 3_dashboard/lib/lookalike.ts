// LETTERS THAT ARE NOT LETTERS.
//
// A product name can be served in Greek and Cyrillic glyphs standing in for
// Latin ones — ρυrіfуtеxt for purifytext — the admin's "name as" setting on the
// top-comments list. Every matcher here strips text to [a-z0-9] before looking
// for a product, which would collapse that word to "rft": the scan would stop
// seeing our own comments, the top list would stop measuring them, and a video
// carrying one would look empty.
//
// So lookalikes are folded back BEFORE the stripping. The same table as
// 6_comment_liker/like.py's LOOKALIKE, so the liker and the dashboard agree on
// what counts as one of ours.
const LOOKALIKE: Record<string, string> = {
  // Greek
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u',
  χ: 'x', γ: 'y', η: 'n', μ: 'm', σ: 's', ς: 's', ω: 'w', θ: 'o', δ: 'd', λ: 'l',
  π: 'n', φ: 'f', ϲ: 'c', ϳ: 'j',
  // Cyrillic
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p', т: 't',
  у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ѡ: 'w', ԝ: 'w', я: 'r',
  и: 'u', л: 'l', г: 'r', п: 'n', ф: 'f', б: 'b', з: 'z', ч: 'ch', ц: 'u', є: 'e',
  ї: 'i', ў: 'u', ё: 'e', һ: 'h', ӏ: 'l',
  // Latin lookalikes outside a-z
  ı: 'i', ȷ: 'j', ɑ: 'a', ɡ: 'g', ɩ: 'i', ℓ: 'l',
}

/**
 * Lookalike glyphs back to the Latin letters they stand in for, lowercased.
 *
 * NFKC first: that alone turns full-width (ｐ) and mathematical (𝗽) Latin into
 * plain letters. NFD then splits accents off so "pürify" is purify.
 */
export function fold(s: string): string {
  const base = String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
  let out = ''
  for (const ch of Array.from(base)) out += LOOKALIKE[ch] ?? ch
  return out
}

/** fold(), then letters and digits only — how a product name is matched. */
export function flatFold(s: string): string {
  return fold(s).replace(/[^a-z0-9]/g, '')
}

/** Does this alias still read as the product to every matcher we have? */
export function aliasMatchesProduct(alias: string, product: string): boolean {
  return flatFold(alias) === flatFold(product)
}

function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every way the product name can appear in a comment, as one regex: each letter
 * in either case or as any of its lookalikes, with an optional space, hyphen,
 * underscore or dot between letters — "PurifyText", "purify text",
 * "Purify-Text" and "ρυrіfуtеxt" all match. An inflection after the name
 * ("purify texted") is left in place.
 */
function nameRegex(product: string): RegExp | null {
  const letters = Array.from(flatFold(product))
  if (letters.length === 0) return null
  const byLatin: Record<string, string[]> = {}
  for (const [glyph, latin] of Object.entries(LOOKALIKE)) {
    if (latin.length === 1) (byLatin[latin] ??= []).push(glyph, glyph.toUpperCase())
  }
  const cls = (c: string) => {
    const alts = Array.from(new Set([c, c.toUpperCase(), ...(byLatin[c] ?? [])]))
    return `[${alts.map(escapeRe).join('')}]`
  }
  return new RegExp(letters.map(cls).join('[\\s\\-_.]?'), 'g')
}

/** The comment with every mention of the product written as `alias`. */
export function applyProductAlias(text: string, product: string, alias: string): string {
  const re = nameRegex(product)
  if (!re || !alias) return text
  return text.replace(re, alias)
}
