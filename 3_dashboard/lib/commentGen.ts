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
  LINK_CATEGORIES,
  isCommentVoice,
  type CommentVoice,
} from './config'
import { groqChat } from './groq'
import { buildAudiencePrompt } from './commentPrompt'
import { COMMENTS } from './comments'
import {
  getProductCommentSettings,
  addCategoryVoice,
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

/** Blank line between the prompt's sections, so they read as separate rules. */
const SEP = '\n\n'

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
// A question that puts OUR OWN product in doubt.
//
// Always rejected, under every voice. "does purify text actually work?" argues
// the case against us, under our own comment, in our own words — worse than
// saying nothing. The subject is a bounded gap rather than a fixed word, because
// the product name sits where "it" would: "is purify text any good" is the same
// question as "is it any good".
const SELF_DOUBT = new RegExp(
  [
    String.raw`\b(is|are|was|were)\s+[\w .']{0,24}?\s*(any\s+good|legit|worth\s+it|real|safe|reliable|accurate)\b`,
    String.raw`\bdoes\s+(it|this|that)\s+(actually\s+|really\s+|even\s+)?work\b`,
    String.raw`\bhas\s+anyone\s+(tried|used|tested)\b`,
    String.raw`\bshould\s+i\s+(use|try|get)\b`,
    String.raw`\bworth\s+(it|trying|using)\b`,
  ].join('|'),
  'i'
)

// A question that invites a comparison.
//
// WANTED under the question voice and banned under the curious one, which is
// why it is separate from SELF_DOUBT. Asking the creator to measure what they
// are showing against our product is the whole point of that voice — "how does
// this compare to purify text?" treats it as the benchmark without claiming
// anything, and nobody argues with a question. The curious voice is the
// opposite shape (the person is the subject, the product a passing aside), so a
// comparison there turns it back into an advert.
const COMPARISON = new RegExp(
  [
    String.raw`\bwhich\s+(one|is)\s+(is\s+)?better\b`,
    String.raw`\bis\s+it\s+better\s+than\b`,
    String.raw`\b(any|other)\s+alternatives?\b`,
  ].join('|'),
  'i'
)

// A line that endorses, compares, or speaks from personal experience.
//
// Only applied under the INFORMATIONAL voice, where the whole point is that the
// comment says what the tool is and stops. The model drifts back to praise
// within a batch or two — it is what almost every seed comment does — and a
// "recommendation with the adjectives removed" is still a recommendation.
const ENDORSING = new RegExp(
  [
    // First person about one's own results.
    String.raw`\bi\s+(use|used|switched|tried|love|recommend|swear)\b`,
    String.raw`\bmy\s+(essay|essays|paper|papers|work|writing|thesis|assignment)\b`,
    String.raw`\bmine\s+(passes|passed|comes\s+back)\b`,
    String.raw`\bworks\s+for\s+me\b`,
    // Telling the reader what to do.
    String.raw`\byou\s+(should|need\s+to|have\s+to|gotta|must)\b`,
    String.raw`\b(try|use|get)\s+it\s+(now|today)\b`,
    // Superlatives and rankings.
    String.raw`\b(best|top|greatest|perfect|unbeatable|amazing|incredible|insane|goat)\b`,
    String.raw`\b(the\s+only\s+one|nothing\s+else|no\s+other)\b`,
    // Comparisons.
    String.raw`\bbetter\s+than\b`,
    String.raw`\bbeats?\s+(every|all|the)\b`,
  ].join('|'),
  'i'
)

// Is anyone actually being addressed? The curious voice asks a person something;
// a line with no "you" in it is a rhetorical question wearing a friendly tone.
const SECOND_PERSON = new RegExp(String.raw`\b(you|your|you're|youre|u|ur)\b`, 'i')

// A comment written by the company rather than by a person.
//
// The writer is supposed to be an ordinary user who does not know the jargon.
// The model knows it perfectly well and drifts back into it — "bypasses every
// detector", "0% ai output", "this tool humanizes your content" — and a line
// like that is the single clearest tell that a comment was planted, because no
// classmate has ever described a website that way.
//
// Rejected, not rewritten: the vocabulary is the giveaway, and swapping words
// out of a sentence built around them leaves the same sentence.
//
// Deliberately NOT banned: turnitin, gptzero and the other product names, and
// "ai" on its own. Students say those every day — "turnitin didn't flag it" is
// exactly the register we want, and banning it would leave nothing concrete to
// say. What is banned is the register around them.
// NARROW ON PURPOSE. The first version of this banned "detector", "tool" and any
// percentage, and it rejected entire batches — a student saying "turnitin
// flagged it" or "it came back 0%" is exactly the register we want, and the
// ai_detector audience has almost nothing else to talk about. A filter that
// leaves nothing for the model to say produces "No valid rewrites returned",
// not better comments.
//
// So this catches only words no ordinary person reaches for. Shaping the rest
// is the prompt's job; this is the backstop for when it drifts.
const JARGON = new RegExp(
  [
    String.raw`\bhumaniz(e|es|ed|er|ers|ing|ation)\b`,
    String.raw`\bai[\s-]?(content|text|writing|generated)\b`,
    String.raw`\bbypass(es|ed|ing)?\b`,
    String.raw`\bundetectable\b`,
    String.raw`\balgorithm(s|ic)?\b`,
    String.raw`\bparaphras(e|es|ed|ing|er)\b`,
    String.raw`\b(nlp|api)\b`,
    // The company's nouns for itself. "tool" is deliberately absent: people do
    // say "this tool", and banning it cost more than it bought.
    String.raw`\b(software|platform|solution|technology|engine)\b`,
    String.raw`\b(output|input)s?\b`,
    String.raw`\bgenerat(e|es|ed|ing|ion)\b`,
    String.raw`\b(accuracy|efficiency|seamless(ly)?|effortless(ly)?|optimi[sz]e[ds]?)\b`,
  ].join('|'),
  'i'
)

/** Does the line read as a question at all? */
function isQuestion(s: string): boolean {
  return /\?\s*$/.test(stripEmoji(s).trim())
}

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
    // Question style is not decoration: the whole point is that the claim is
    // presupposed rather than asserted. A line that is not a question, or one
    // that questions the product instead of assuming it, is thrown away rather
    // than posted — there is always another line in the batch.
    //
    // Only when the product is SET to question style. With it off, a comment
    // ending in a question mark is just a comment, and DOUBTING would be
    // reading statements for a rule they were never written under.
    // Both question voices must actually be questions, and neither may argue
    // against the product. They differ in what the question is ABOUT, which is
    // the prompt's job; these two rules are the same for both.
    if (style.voice === 'question' || style.voice === 'curious') {
      if (!isQuestion(s)) continue
      // Never allowed either way: our own product questioned.
      if (SELF_DOUBT.test(s)) continue
      // Comparisons are the POINT of the question voice and the ruin of the
      // curious one — see COMPARISON.
      if (style.voice === 'curious' && COMPARISON.test(s)) continue
    }
    // A curious comment is addressed to a PERSON. Without a second person in it
    // the model has written a rhetorical question again, which is the other
    // voice — and the whole difference between the two is who is being asked.
    if (style.voice === 'curious' && !SECOND_PERSON.test(s)) continue
    // Informational means informational: a line that endorses, compares or
    // speaks in the first person is a recommendation wearing a flat tone.
    if (style.voice === 'informational' && ENDORSING.test(s)) continue
    if (opts.banCliches && CLICHES.test(s)) continue
    // Rejected everywhere, not behind a flag. The audience sets banned
    // comparison words but the MAIN set banned nothing, which is how the
    // taglines above reached the app.
    if (SLOGANS.test(s)) continue
    // Written by the company rather than by a person — see JARGON. Applies to
    // every voice: the informational one is the plainest, not the most
    // technical, and it drifts hardest because "state what it is" reads to the
    // model as an invitation to describe the product.
    if (JARGON.test(s)) continue
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
/**
 * Completion budget for one batch.
 *
 * The JSON is the SMALL part. gpt-oss is a reasoning model: measured on a real
 * 38-item batch it spent 2,113-3,105 tokens thinking and about 560 on the
 * answer, and the thinking grows with the prompt. The old cap was sized for the
 * answer alone (600 + 104/item = 4,552 at full batch), which left roughly a
 * thousand tokens of headroom — so a longer prompt tipped it over and Groq
 * returned `json_validate_failed: max completion tokens reached before
 * generating a valid document`, with the whole batch lost.
 *
 * The reserve is therefore explicit and generous. It costs nothing when unused:
 * max_tokens is a ceiling, not a spend, and the measurements above show the
 * model uses FEWER tokens when given more room, not more.
 */
const REASONING_RESERVE = 4500

function tokenCap(count: number, band: WordBand): number {
  return Math.min(16000, Math.max(6000, REASONING_RESERVE + count * tokensPerItem(band)))
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

/**
 * Generate + persist one product's comments for ONE AUDIENCE, replacing what is
 * stored. Every comment served is an audience comment — there is no
 * audience-neutral set any more — so this and appendToCategory are the only two
 * ways comments come into existence.
 */
export async function regenerateCategoryProducts(
  products: readonly Product[],
  categories: readonly LinkCategory[] = LINK_CATEGORIES
): Promise<Record<string, { ok: boolean; count?: number; error?: string }>> {
  const out: Record<string, { ok: boolean; count?: number; error?: string }> = {}
  // Sequential, not parallel: concurrent rewrites of the same product hit the
  // Groq tokens-per-minute limit and the later ones simply fail. One that gets
  // rate-limited anyway is left for the next run or the lazy 24h refresh.
  for (const p of products) {
    for (const c of categories) {
      const key = `${p}/${c}`
      try {
        out[key] = { ok: true, count: await regenerateCategory(p, c) }
      } catch (e) {
        out[key] = { ok: false, error: String(e) }
      }
    }
  }
  return out
}

/**
 * Generate another batch for one audience and ADD it to what is stored.
 *
 * Regenerating replaces the set, which is right when a voice is being tuned and
 * wrong when the aim is a MIX: a comment section where every line is the same
 * shape reads as one person with several accounts. This generates with whatever
 * voice is set right now and appends, so a set can be built up from two or three
 * voices by switching the voice and pressing Add again.
 *
 * Deduped against the stored set on the same key sanitize() uses within a batch —
 * text without emoji, lowercased — so running it twice on one voice does not
 * double the set, and a line the model happens to repeat is dropped rather than
 * stored twice.
 *
 * Returns how many were actually added, which is the number worth reporting: a
 * batch of 30 that adds 4 has told you the voice is exhausted.
 */
export async function appendToCategory(
  product: Product,
  category: LinkCategory
): Promise<{ added: number; total: number }> {
  const base = baseComments(product)
  if (base.length === 0) return { added: 0, total: 0 }
  const { band, style } = await settingsFor(product)
  const fresh = await callGroqForAudience(product, category, sample(base, batchSize(band)), band, style)

  const stored = (await getCategoryComments(product, category).catch(() => null))?.comments ?? []
  const key = (t: string) => stripEmoji(t).toLowerCase()
  const seen = new Set(stored.map(key))
  const added: string[] = []
  for (const c of fresh) {
    const k = key(c)
    if (seen.has(k)) continue
    seen.add(k)
    added.push(c)
  }
  const merged = [...stored, ...added]
  await saveCategoryComments(product, category, merged)
  // Record the voice on the set, so the nightly rebuild makes this batch again
  // instead of flattening the mix back to one voice. Done even when the batch
  // added nothing new: the voice was still asked for, and an admin who presses
  // Add twice means it both times.
  await addCategoryVoice(product, category, style.voice).catch(() => [])
  return { added: added.length, total: merged.length }
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
  const system = buildAudiencePrompt(product, category, band, style)

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
 * One batch for one audience in one voice, retried once.
 *
 * Two attempts, each on a fresh sample. The cliche filter can reject most of a
 * batch when the model falls back into ad language, and a silent failure here
 * would leave the audience showing yesterday's comments with no sign anything
 * went wrong.
 */
async function batchForVoice(
  product: Product,
  category: LinkCategory,
  base: string[],
  band: WordBand,
  style: CommentStyle,
  voice: CommentVoice
): Promise<string[]> {
  const styled: CommentStyle = { ...style, voice }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await callGroqForAudience(
        product,
        category,
        sample(base, batchSize(band)),
        band,
        styled
      )
      if (out.length > 0) return out
    } catch (e) {
      if (attempt === 1) throw e
    }
  }
  return []
}

/**
 * Generate + persist one product's comments for one audience, REBUILDING THE
 * WHOLE MIX.
 *
 * A set is a deliberate blend: generate on one voice, switch the voice, add
 * another batch. That is the only way a comment section stops reading as one
 * person with several accounts. Regeneration used to throw it away — it made a
 * single batch in whatever voice happened to be selected, so the nightly cron
 * flattened every mix an admin had built, overnight, silently.
 *
 * Now the voices a set was built from are recorded on the set itself, and a
 * regeneration makes one batch per recorded voice and merges them. A set with
 * no recorded mix uses the product's current voice, which is exactly what every
 * set did before, and records it so the next rebuild matches this one.
 *
 * Deduped across voices on the same key appendToCategory uses, so two voices
 * that happen to produce the same line store it once.
 */
export async function regenerateCategory(
  product: Product,
  category: LinkCategory
): Promise<number> {
  const base = baseComments(product)
  if (base.length === 0) return 0
  const { band, style } = await settingsFor(product)

  const stored = await getCategoryComments(product, category).catch(() => null)
  const recorded = (stored?.voices ?? []).filter(isCommentVoice)
  const voices: CommentVoice[] = recorded.length ? recorded : [style.voice]

  const key = (t: string) => stripEmoji(t).toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  const usedVoices: CommentVoice[] = []
  let lastError: unknown = null

  // Sequential, not parallel: several batches for one product at once exhaust
  // the Groq tokens-per-minute budget and the later ones simply fail.
  for (const voice of voices) {
    let batch: string[] = []
    try {
      batch = await batchForVoice(product, category, base, band, style, voice)
    } catch (e) {
      // One voice failing must not lose the others. Remembered so a total
      // failure still throws rather than quietly writing an empty set.
      lastError = e
      continue
    }
    if (batch.length === 0) continue
    usedVoices.push(voice)
    for (const c of batch) {
      const k = key(c)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(c)
    }
  }

  if (out.length === 0) {
    if (lastError) throw lastError
    return 0
  }
  // Record the voices that ACTUALLY produced something. A voice that failed
  // tonight stays in the recipe only if it worked — otherwise a permanently
  // broken voice would be retried forever and its absence never noticed.
  await saveCategoryComments(product, category, out, usedVoices)
  return out.length
}

/**
 * One product's comments for one audience, regenerating when stale.
 *
 * There is no audience-neutral set to fall back to any more. If this pair has
 * never been generated and generating it here fails, the answer is an empty
 * list, and the caller looks to another product for the same audience rather
 * than serving a comment written for nobody in particular.
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
        // fall through to whatever is already stored, even if it is stale
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
  // Never generated, and generating it just now did not work either.
  return { comments: [], generatedAt: null }
}
