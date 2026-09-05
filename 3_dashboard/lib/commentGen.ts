import {
  type Product,
  isProduct,
  DEACTIVATED_PRODUCTS,
  PRODUCTS,
  COMMENT_REFRESH_MS,
  COMMENT_WORD_MIN,
  COMMENT_WORD_MAX,
  productWords,
  productMatchWords,
  productMention,
  type CommentStyle,
  DEFAULT_COMMENT_STYLE,
  type LinkCategory,
} from './config'
import { groqChat } from './groq'
import { COMMENTS } from './comments'
import {
  getGeneratedComments,
  saveGeneratedComments,
  acquireCommentLock,
  releaseCommentLock,
  getProductCommentSettings,
  getCategoryComments,
  saveCategoryComments,
  acquireCategoryLock,
  releaseCategoryLock,
  type WordBand,
} from './db'

// How long a single regeneration is allowed to hold the lease before another
// request may take over (covers a crash mid-generation).
const LOCK_LEASE_MS = 2 * 60 * 1000

// Emoji, variation selectors and ZWJ joiners. Written as explicit code-unit
// ranges rather than \p{Emoji} because Unicode property escapes need a /u flag
// this tsconfig target rejects. The surrogate-pair clause covers U+1F300-1FAFF,
// which is where the everyday emoji live.
const EMOJI =
  /[\u2190-\u21FF\u2300-\u27BF\u2B00-\u2BFF\u2600-\u26FF\uFE0F\u200D]|[\uD800-\uDBFF][\uDC00-\uDFFF]/g

// Upbeat only — the tone is "this worked out", never sarcasm or panic. Picked by
// position so a batch gets a spread instead of the same face on every line.
const VIBES = ['\u{1F64C}', '\u2728', '\u{1F4AF}', '\u{1F525}', '\u{1FAF6}', '\u{1F44F}', '\u{1F4AA}', '\u{1F60C}']

/** The text with every emoji removed and whitespace collapsed. */
/** Variation selectors and ZWJ are parts of an emoji, not emoji themselves. */
function isModifier(c: string): boolean {
  return c === String.fromCharCode(0xfe0f) || c === String.fromCharCode(0x200d)
}

/** The least-used upbeat emoji so far, rotating on ties. */
function nextVibe(used: Map<string, number>, i: number): string {
  let best = VIBES[i % VIBES.length]
  let bestN = Infinity
  for (let k = 0; k < VIBES.length; k++) {
    const v = VIBES[(i + k) % VIBES.length]
    const n = used.get(v) ?? 0
    if (n < bestN) { best = v; bestN = n }
  }
  return best
}
function stripEmoji(s: string): string {
  return s.replace(EMOJI, '').replace(/\s+/g, ' ').trim()
}

function countEmoji(s: string): number {
  return (s.match(EMOJI) || []).filter((c) => !isModifier(c)).length
}

// Emoji never count towards the word band: a comment is judged on its words.
function wordCount(s: string): number {
  return stripEmoji(s).split(/\s+/).filter(Boolean).length
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')
}

/**
 * Rewrite however the model spelled the product into the one canonical form.
 *
 * Accepts purifytext / purify text / purify-text / \"Purify Text\" and returns the
 * comment with exactly \"purify text\" in its place. Returns null when the product is
 * not mentioned at all, which is still a rejection.
 */
function canonicaliseMention(s: string, product: Product, style: CommentStyle): string | null {
  // Matched on the SPLIT form so either spelling is recognised, emitted in
  // whichever form the admin chose. Matching and emitting are different jobs.
  const match = productMatchWords(product)
  const re = new RegExp(match.split(' ').map(escapeRe).join('[\\s._-]*'), 'i')
  const m = re.exec(s)
  if (!m) return null
  // Existing quotes are stripped either way: with quoting off they must go, and
  // with it on they would otherwise be doubled.
  const before = s.slice(0, m.index).replace(/["'\u201C\u2018]$/, '')
  const after = s.slice(m.index + m[0].length).replace(/^["'\u201D\u2019]/, '')
  return before + productMention(product, style) + after
}

// Keep only rewrites that obey the rules: mention the product, land inside the
// word-count band, and are unique. This is the safety net around the LLM.
// Target word counts for one batch, spread evenly across the band and shuffled.
//
// Asking the model for "3 to 8 words" produces a clump — it settles on one
// comfortable length and repeats it. Handing each line its OWN target is what
// actually yields a mix of short and long comments. Shuffled so the batch does
// not arrive sorted by length.
function targetLengths(count: number, band: WordBand): number[] {
  const span = band.max - band.min + 1
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(band.min + (i % span))
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// Phrases the model reaches for when it is told "better than the rivals", which
// is how three audiences ended up sounding like one: "beats rivals", "totally
// beats the other", "beats them all easily", "simply unbeatable". A real person
// says WHY they switched; only an ad says it wins. Rejected outright, so the
// prompt's instruction is enforced rather than merely requested.
const CLICHES =
  /\b(beats?|beating|unbeatable|outperform\w*|outclass\w*|outrun\w*|wins?|winning|winner|rivals?|competitors?|competition|the\s+other\s+one|no\s+other\s+tool|number\s*one|hands\s+down|game\s*changer|superior)\b/i

// Ad copy, as opposed to a recommendation.
//
// These are what the model produced when the prompt asked it to "hype it up":
// "acoustic text is my league forever", "humlexic takes the obvious #1 spot",
// "acoustictext is my secret bypass weapon". Every one is a tagline — it crowns
// the product without telling a reader anything they could act on, and a comment
// section full of them reads as paid promotion at a glance.
//
// Kept to phrasings that are ONLY ever advertising. Ordinary enthusiasm is not
// the problem and is deliberately left alone: "so good", "love it", "never had
// an issue" are all things people actually type.
const SLOGANS =
  /(#\s*1\b|\bno\.?\s*1\b|\bsecret\s+(\w+\s+)?weapon\b|\bholy\s+grail\b|\bthe\s+goat\b|\bgoated\b|\bundefeated\b|\bking\s+of\b|\bqueen\s+of\b|\bcrowned?\b|\breigns?\b|\bunmatched\b|\bunrivall?ed\b|\bflawless\b|\bmy\s+league\s+forever\b|\bchanged\s+my\s+life\b|\b10\s*\/\s*10\b|\bs-?tier\b|\bcheat\s+code\b|\bmagic\s+wand\b)/i

// A comment that stops on a connective word reads broken: "stopped the flags for",
// "my essays pass with purifytext every". The model produces these when it
// trims a sentence to hit its exact word target, and they are already sitting in
// the stored sets, so they are rejected outright rather than posted.
const DANGLING = new RegExp(
  '(^|\\s)(' + 'a|an|and|as|at|but|by|for|from|in|into|is|its|just|like|my|of|on|or|our|really|so|than|the|their|then|to|very|was|were|when|while|with|without|your|about|after|before|every|even|have|has|had|do|does|did|will|would|can|could|get|gets|got|be|been|am|are' + ')[.,!?\\s]*$',
  'i'
)
function sanitize(
  product: Product,
  lines: unknown,
  band: WordBand,
  opts: { banCliches?: boolean; style?: CommentStyle } = {}
): string[] {
  const style = opts.style ?? DEFAULT_COMMENT_STYLE
  if (!Array.isArray(lines)) return []
  const seen = new Set<string>()
  const out: string[] = []
  // How many kept comments already end on each emoji, so no one face takes over.
  const used = new Map<string, number>()
  const lineCount = Array.isArray(lines) ? lines.length : 0
  const needle = product.toLowerCase()
  for (const raw of lines) {
    if (typeof raw !== 'string') continue
    let s = raw.trim().replace(/^["'\s]+|["'\s]+$/g, '')
    if (!s) continue
    // MUST mention the product; the mention is normalised to \"purify text\" here
    // rather than trusted to the model, so every stored comment is identical
    // in that one respect.
    const named = canonicaliseMention(s, product, style)
    if (named === null) continue
    s = named
    const n = wordCount(s)
    if (n < band.min || n > band.max) continue
    if (opts.banCliches && CLICHES.test(s)) continue
    // Rejected everywhere, not behind a flag. The audience sets banned
    // comparison words but the MAIN set banned nothing, which is how the
    // taglines above reached the app.
    if (SLOGANS.test(s)) continue
    if (DANGLING.test(stripEmoji(s))) continue
    // One or two upbeat emoji, appended when the model forgot and trimmed when
    // it got carried away. Doing it here rather than rejecting keeps a good
    // comment that simply missed one instruction.
    const n_emoji = countEmoji(s)
    if (!style.emoji) {
      // Emoji switched off: strip whatever the model produced anyway, rather
      // than rejecting the line over a rule it was never told about.
      if (n_emoji > 0) s = stripEmoji(s)
    } else if (n_emoji === 0) s = s + ' ' + nextVibe(used, out.length)
    else if (n_emoji > 2) {
      let kept = 0
      s = s.replace(EMOJI, (c) => (c === '\uFE0F' || c === '\u200D' || ++kept <= 2 ? c : '')).trim()
    }
    // Spread them across the batch. Told to vary the emoji, the model still
    // lands on one face for most of a run, and a pool where every comment ends
    // the same way is exactly the pattern that reads as automated.
    const face = style.emoji ? (s.match(EMOJI) || []).find((c) => !isModifier(c)) : undefined
    if (face) {
      const cap = Math.max(2, Math.ceil(lineCount / VIBES.length))
      if ((used.get(face) ?? 0) >= cap) {
        const swap = nextVibe(used, out.length)
        s = s.replace(face, swap)
        used.set(swap, (used.get(swap) ?? 0) + 1)
      } else {
        used.set(face, (used.get(face) ?? 0) + 1)
      }
    }
    const key = stripEmoji(s).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

// Ask Groq's OpenAI-compatible endpoint to rewrite this product's theme bank
// into fresh, very short comments. Throws on any failure so callers can fall
// back to whatever is already stored.
async function callGroq(
  product: Product,
  base: string[],
  band: WordBand,
  style: CommentStyle
): Promise<string[]> {
  // The BARE form the model is asked for. Any quoting is applied by
  // canonicaliseMention() after the JSON is parsed: asking the model to emit
  // quotes inside a JSON string is a needless escaping hazard, and
  // json_validate_failed is how that shows up.
  const mention = productWords(product, style.splitBrand)
  // One target length per input line, spread across the band.
  const targets = targetLengths(base.length, band)
  const system =
    `"${product}" is an AI humanizer website — it rewrites AI-generated text so it reads ` +
    `as human and bypasses every AI detector (Turnitin, GPTZero, Originality, Copyleaks, ` +
    `ZeroGPT, etc.). ` +
    // The voice is the whole job here. Asked to "hype it up", the model wrote
    // mascot lines — "is my league forever", "takes the obvious #1 spot", "my
    // secret bypass weapon" — which say nothing a reader can act on and read as
    // paid promotion at a glance. A recommendation is a person telling you what
    // they use and why it worked for them.
    `You write comments from ONE point of view: a real person who has used it and ` +
    `recommends it as the best humanizer — the one that gets their work past every ` +
    `detector, at 0% AI, every time. ` +
    `Write a RECOMMENDATION, never a slogan. It must sound like someone answering ` +
    `"what do you use?" in a comment section — first person, from their own experience ` +
    `("i use", "i switched to", "mine passes", "works for me"). ` +
    `Banned outright: taglines, mascot lines, ad copy and anything that reads like a ` +
    `brand caption — no "#1", no "secret weapon", no "holy grail", no "goat", no ` +
    `"undefeated", no "king of", no "never fails" as a catchphrase, no crowning it, ` +
    `no rhymes, no wordplay on the product name. ` +
    `For each original comment, write ONE fresh comment that keeps the SAME core ` +
    `recommendation as the original — that it is the best humanizer and that it passes ` +
    `the detectors. Do not invent unrelated themes and do not drop the claim. ` +
    // Diversity has to be in the REASON, not in the adjectives, or every comment
    // becomes the same sentence with a different superlative in it.
    `Make the batch genuinely varied by changing WHAT the recommendation rests on, ` +
    `not by swapping in bigger words: what you tried before it, the score that came ` +
    `back, the assignment you trusted it with, how long you have used it, that it still ` +
    `sounds like your own writing, that you stopped double-checking, who you told about ` +
    `it. Different comments should lean on different ones of those. ` +
    `Every rewrite MUST: be between ${band.min} and ${band.max} words, ` +
    `match the EXACT word count requested for its line (each input names one), ` +
    `so the batch contains a real mix of short and long comments, ` +
    `write the product as the two words ${mention} - exactly that spelling and ` +
    `spacing, and do NOT put quotes around it - be lowercase and casual like a real ` +
    `social-media reply, contain no hashtags and no quotes around the whole comment. ` +
    (style.emoji
      ? `End each comment with one upbeat emoji that fits what it says - vary them ` +
        `across the batch. Emoji do not count towards the word total. `
      : `Use no emoji at all. `) +
    `Return strict JSON: {"comments": ["...", ...]} with one rewrite per input, in the same order.`

  // Each item carries its own word target, which is what produces varied
  // lengths: a single "between X and Y" instruction makes the model settle on
  // one comfortable length and repeat it for the whole batch.
  const items = base.map((text, i) => ({ text, words: targets[i] }))
  const user =
    `Rewrite these ${base.length} comments. Each item gives the original text and ` +
    `the exact number of words its rewrite must have:\n${JSON.stringify(items, null, 0)}`

  // groqChat tries each model in GROQ_MODELS, falling back on a quota/429 error.
  // Free tier counts (input + output) tokens/minute, so keep the cap modest.
  const { content } = await groqChat({
    temperature: 0.9,
    jsonObject: true,
    maxTokens: tokenCap(base.length, band),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Groq returned non-JSON content')
  }
  const arr = (parsed as { comments?: unknown })?.comments
  // banCliches applies here as well now. It used to be set only for the
  // audience sets, so "takes the obvious #1 spot" was filtered out of one
  // path and waved through the other — and the other is where most comments
  // come from.
  const clean = sanitize(product, arr, band, { style, banCliches: true })
  if (clean.length === 0) throw new Error('No valid rewrites returned')
  return clean
}

/**
 * This product's band and writing style, with the compiled defaults as backup.
 *
 * One helper because every generation path needs both, and reading them apart
 * is how a regeneration ends up honouring the length but not the style.
 */
async function settingsFor(product: Product): Promise<{ band: WordBand; style: CommentStyle }> {
  const dflt = { min: COMMENT_WORD_MIN, max: COMMENT_WORD_MAX }
  return getProductCommentSettings(product, dflt).catch(() => ({
    band: dflt,
    style: DEFAULT_COMMENT_STYLE,
  }))
}

/** Base "theme" comments for a product (the source of truth for meaning). */
function baseComments(product: Product): string[] {
  return COMMENTS[product] ?? []
}

// The most base comments we rewrite in one generation. The whole theme bank can
// be ~90 comments, which is too many tokens for a single free-tier request
// (8000 tokens/min). Rewriting a rotating sample keeps every request small AND
// gives day-to-day variety. Bump this if you move to a higher Groq tier.
const MAX_INPUT = 40

// Roughly how many completion tokens one rewrite costs: ~2 per word, plus the
// JSON quoting, comma and whitespace around it. Deliberately generous — the
// failure mode of guessing low is the model running out of room mid-array and
// Groq rejecting the whole response with json_validate_failed.
const tokensPerItem = (band: WordBand): number => band.max * 4 + 40

// Keep one response comfortably inside a single completion. A wider word band
// costs more per line, so the BATCH shrinks rather than the token cap growing
// without limit — which is what broke when the band went from 3-8 to 6-16.
const OUTPUT_BUDGET = 4000

function batchSize(band: WordBand): number {
  return Math.max(8, Math.min(MAX_INPUT, Math.floor(OUTPUT_BUDGET / tokensPerItem(band))))
}

// The cap sent to Groq: what this batch can actually need, plus room for the
// model's own preamble. Never below the old fixed value, never absurd.
function tokenCap(count: number, band: WordBand): number {
  return Math.min(8000, Math.max(1500, 600 + count * tokensPerItem(band)))
}

// Pick up to n items at random (Fisher–Yates on a copy). A fresh sample each
// run means the rewritten set shifts over time even beyond the model's own
// phrasing variety.
function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice()
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n)
}

// Generate + persist a fresh set for one product in a single, budget-sized LLM
// call. Used by the manual per-product trigger and the daily cron. Returns the
// number of comments stored.
export async function regenerateProduct(product: Product): Promise<number> {
  const base = baseComments(product)
  if (base.length === 0) return 0
  const { band, style } = await settingsFor(product)
  const fresh = await callGroq(product, sample(base, batchSize(band)), band, style)
  await saveGeneratedComments(product, fresh)
  return fresh.length
}

// Regenerate several products one at a time, swallowing per-product errors so
// one failure doesn't abort the batch. Sequential (not parallel) so we don't
// fire several requests into the free-tier tokens-per-minute limit at once; a
// product that still gets rate-limited is left for the next cron / lazy refresh.
export async function regenerateProducts(
  products: readonly Product[] = PRODUCTS.filter((p) => !DEACTIVATED_PRODUCTS.includes(p))
): Promise<Record<string, { ok: boolean; count?: number; error?: string }>> {
  const out: Record<string, { ok: boolean; count?: number; error?: string }> = {}
  for (const p of products) {
    try {
      out[p] = { ok: true, count: await regenerateProduct(p) }
    } catch (e) {
      out[p] = { ok: false, error: String(e) }
    }
  }
  return out
}

/**
 * Return the comments a user should see for their product, regenerating first
 * if the stored set is missing or older than the 24h refresh window. Only one
 * request regenerates at a time (via the DB lease); everyone else is served the
 * current cache. Falls back to the static theme bank if generation fails and
 * nothing is stored yet.
 */
export async function getFreshComments(
  product: string
): Promise<{ comments: string[]; generatedAt: string | null }> {
  if (!isProduct(product)) return { comments: [], generatedAt: null }

  const current = await getGeneratedComments(product)
  const age = current?.generated_at ? Date.now() - new Date(current.generated_at).getTime() : Infinity
  const stale = !current || current.comments.length === 0 || age > COMMENT_REFRESH_MS

  if (stale) {
    const won = await acquireCommentLock(product, LOCK_LEASE_MS)
    if (won) {
      try {
        const fresh = await regenerateProduct(product)
        if (fresh > 0) {
          const saved = await getGeneratedComments(product)
          return {
            comments: saved?.comments ?? [],
            generatedAt: saved?.generated_at ? new Date(saved.generated_at).toISOString() : null,
          }
        }
      } catch {
        // fall through to whatever we have / the static bank
      } finally {
        await releaseCommentLock(product).catch(() => {})
      }
    }
  }

  if (current && current.comments.length > 0) {
    return {
      comments: current.comments,
      generatedAt: current.generated_at ? new Date(current.generated_at).toISOString() : null,
    }
  }
  // Nothing generated yet (or generation failed). The static bank spells the
  // product as one word and carries no emoji, so it goes through the same
  // normaliser the generated sets do - otherwise the fallback would post a
  // differently-shaped comment than everything else.
  const { band, style } = await settingsFor(product as Product)
  const fallback = sanitize(
    product as Product,
    baseComments(product as Product),
    { min: 1, max: Math.max(band.max, 60) },
    { style }
  )
  return { comments: fallback, generatedAt: null }
}

// ── Audience-tailored comments ───────────────────────────────────────────────
// The same product, pitched three ways. A link's category (lib/linkCategory.ts)
// decides which set the app serves under it, so the comment answers what that
// video's viewers are actually thinking about.
//
// Each audience adds an ANGLE to the normal prompt; the hard rules (word count,
// must name the product, lowercase, no emojis) are unchanged, so sanitize() is
// the same safety net for all three.

const AUDIENCE_ANGLE: Record<LinkCategory, string> = {
  competitors:
    'AUDIENCE: the video promotes or reviews a RIVAL humanizer, and the viewer is already ' +
    'shopping for one.\n' +
    'WHO YOU ARE: someone who has genuinely been through several of these tools over months ' +
    `and settled on "{PRODUCT}" — not a fan, just someone who stopped looking.\n` +
    'WHAT TO SAY: that it is the most reliable one, that it clears every detector, that it ' +
    'is the one you trust when the submission actually matters. Earn the claim the way a ' +
    'real person does, with a small concrete reason: you kept getting flagged until you ' +
    'switched, you tried a few and this was the only clean one, you stopped re-checking ' +
    'because it always comes back human, it does not mangle your meaning into odd ' +
    'synonyms, you paid for others first and wish you had started here.\n' +
    'NEVER name the rival, and NEVER use comparison-ad words (beats, wins, unbeatable, ' +
    'outperforms, rivals, the competition, number one, hands down, game changer). Let the ' +
    'comparison live in your own experience. Write a comment, not a verdict.',
  ai_detector:
    'AUDIENCE: the video is about AI DETECTORS — Turnitin, GPTZero, Originality, Copyleaks, ' +
    'ZeroGPT, being flagged, AI percentage scores. The viewer is worried about getting ' +
    'caught and may not know a fix exists.\n' +
    'WHO YOU ARE: someone who had exactly that problem and for whom it is simply over now.\n' +
    `WHAT TO SAY: that "{PRODUCT}" gets you past the detector — told specifically, like a ` +
    'person, not a slogan. Vary what you anchor on: the score that came back (0%, 2%, ' +
    'fully human), the moment (pasting it in before submitting, re-running the check, the ' +
    'professor never noticing), a detector by name, how many times it has held up, or that ' +
    'it still reads like your own writing afterwards.\n' +
    'Relief, not sales. Do not open every comment the same way, and do not simply say it ' +
    'saved you — say what actually happened.',
  generic:
    'AUDIENCE: general study, essay, homework or student content, with no tool being ' +
    'discussed. The viewer is not thinking about detectors, so lead with the writing rather ' +
    'than with a warning.\n' +
    'WHO YOU ARE: the same person as in the competitor case — someone who has tried the ' +
    `others and quietly uses "{PRODUCT}" for everything now.\n` +
    'WHAT TO SAY: recommend it with that same conviction — it is the one that actually ' +
    'works, the most reliable, it makes the writing read like you, and yes, it clears the ' +
    'checkers every time. Drop it in the way you would tell a classmate what you use: a ' +
    'tip, not a pitch.\n' +
    'Same ban: no beats / wins / unbeatable / rivals / number-one language.',
}

/** The audience paragraph with the product filled in. */
function angleFor(product: Product, category: LinkCategory): string {
  return AUDIENCE_ANGLE[category].replace(/\{PRODUCT\}/g, product)
}

async function callGroqForAudience(
  product: Product,
  category: LinkCategory,
  base: string[],
  band: WordBand,
  style: CommentStyle
): Promise<string[]> {
  // The BARE form the model is asked for. Any quoting is applied by
  // canonicaliseMention() after the JSON is parsed: asking the model to emit
  // quotes inside a JSON string is a needless escaping hazard, and
  // json_validate_failed is how that shows up.
  const mention = productWords(product, style.splitBrand)
  const targets = targetLengths(base.length, band)
  const system =
    `"${product}" is an AI humanizer website — it rewrites AI-generated text so it reads ` +
    `as human and bypasses every AI detector (Turnitin, GPTZero, Originality, Copyleaks, ` +
    `ZeroGPT, etc.). It is the best humanizer available right now. ` +
    `You write short recommendation comments left under a specific kind of video.\n\n` +
    `${angleFor(product, category)}\n\n` +
    // The original is a STYLE reference only. An earlier version said "keep its
    // general intent", and the three audiences came back nearly identical —
    // "purifytext beats rivals" / "purifytext saved me" / "purifytext saved
    // essay" — because the base comment, not the angle, was driving the message.
    `For each original comment, write ONE fresh comment in the same VOICE and length, but ` +
    `whose MESSAGE comes from the audience above, not from the original. The original is a ` +
    `style reference, not content to preserve — say something that only makes sense to that ` +
    `audience. ` +
    `Every rewrite MUST: be between ${band.min} and ${band.max} words, ` +
    `match the EXACT word count requested for its line, ` +
    `write the product as the two words ${mention} - exactly that spelling and ` +
    `spacing, and do NOT put quotes around it - be lowercase and casual like a real ` +
    `social-media reply, contain no hashtags and no quotes around the whole comment. ` +
    (style.emoji
      ? `End each comment with one upbeat emoji that fits what it says - vary them ` +
        `across the batch. Emoji do not count towards the word total. `
      : `Use no emoji at all. `) +
    `Return strict JSON: {"comments": ["...", ...]} with one rewrite per input, in the same order.`

  const items = base.map((text, i) => ({ text, words: targets[i] }))
  const user =
    `Rewrite these ${base.length} comments for that audience. Each item gives the original ` +
    `text and the exact number of words its rewrite must have:\n${JSON.stringify(items, null, 0)}`

  const { content } = await groqChat({
    temperature: 0.9,
    jsonObject: true,
    maxTokens: tokenCap(base.length, band),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Groq returned non-JSON content')
  }
  const clean = sanitize(product, (parsed as { comments?: unknown })?.comments, band, {
    banCliches: true,
    style,
  })
  if (clean.length === 0) throw new Error('No valid rewrites returned')
  return clean
}

/** Generate + persist one product's comments for one audience. */
export async function regenerateCategory(
  product: Product,
  category: LinkCategory
): Promise<number> {
  const base = baseComments(product)
  if (base.length === 0) return 0
  const { band, style } = await settingsFor(product)
  // Two attempts, each on a fresh sample. The cliche filter can reject most of
  // a batch when the model falls back into ad language, and a silent failure
  // here would leave the audience showing yesterday's comments with no sign
  // anything went wrong.
  let fresh: string[] = []
  for (let attempt = 0; attempt < 2 && fresh.length === 0; attempt++) {
    try {
      fresh = await callGroqForAudience(product, category, sample(base, batchSize(band)), band, style)
    } catch (e) {
      if (attempt === 1) throw e
    }
  }
  if (fresh.length === 0) return 0
  await saveCategoryComments(product, category, fresh)
  return fresh.length
}

/**
 * One product's comments for one audience, regenerating when stale.
 *
 * Falls back to the product's ordinary (audience-neutral) comments when nothing
 * has been generated for this pair yet, so switching the app over to categories
 * never leaves a link with an empty comment pool.
 */
export async function getFreshCategoryComments(
  product: string,
  category: LinkCategory
): Promise<{ comments: string[]; generatedAt: string | null }> {
  if (!isProduct(product)) return { comments: [], generatedAt: null }

  const current = await getCategoryComments(product, category).catch(() => null)
  const age = current?.generated_at ? Date.now() - new Date(current.generated_at).getTime() : Infinity
  const stale = !current || current.comments.length === 0 || age > COMMENT_REFRESH_MS

  if (stale) {
    const won = await acquireCategoryLock(product, category, LOCK_LEASE_MS)
    if (won) {
      try {
        if ((await regenerateCategory(product, category)) > 0) {
          const saved = await getCategoryComments(product, category)
          if (saved && saved.comments.length > 0) {
            return {
              comments: saved.comments,
              generatedAt: saved.generated_at ? new Date(saved.generated_at).toISOString() : null,
            }
          }
        }
      } catch {
        // fall through to whatever exists / the neutral set
      } finally {
        await releaseCategoryLock(product, category).catch(() => {})
      }
    }
  }

  if (current && current.comments.length > 0) {
    return {
      comments: current.comments,
      generatedAt: current.generated_at ? new Date(current.generated_at).toISOString() : null,
    }
  }
  // Nothing audience-specific yet — the ordinary set is still on-message.
  return getFreshComments(product)
}
