// Is a video title about what a given genre sells?
//
// Lifted out of the admin route so the hourly channel harvest classifies by
// exactly the same rules the "Mark unrelated" button uses. Two copies of this
// would drift, and the thing they would drift on is which links reach the pool
// without anyone looking at them.
//
// THE QUESTION HAS A GENRE. It used to ask one thing - "is this about AI
// humanizers?" - which was right while every link was a humanizer link and
// catastrophic afterwards: pressing the button on a website channel's staging
// marked every link unrelated, because a video about building a website is
// genuinely not about humanizers. What counts as related per genre lives in
// lib/prompts.ts (classifySystem) beside the rest of the domain copy.

import { llmChat, llmTakesBigBatches } from './llm'
import { DEFAULT_GENRE, isGenre, type Genre } from './config'
import { GENRE_COPY, classifyReasonSystem, classifySystem, classifyUser, relatedCriteria } from './prompts'
import { ensureGenreRegistry } from './genreStore'
import { getChannelBios } from './db'
import { channelOf } from './dateScore'

/** bio: the posting channel's profile description, '' or absent when unknown. */
export type Item = { url: string; title: string; bio?: string | null }

/**
 * THE CHANNEL BIO, beside the title. A caption like "pov: finals week" says
 * nothing; the same video from a channel whose bio is "AI humanizer tips for
 * students" is plainly our audience. Bios the caller did not send are read
 * from channel_bio by the URL's handle (cached), so every caller — the Mark
 * unrelated button, the rank-only panel, the verify page, the hourly harvest —
 * judges with it.
 */
async function withBios<T extends Item>(items: T[]): Promise<T[]> {
  if (items.every((it) => it.bio)) return items
  const bios = await getChannelBios().catch(() => ({}) as Record<string, string>)
  return items.map((it) => {
    if (it.bio) return it
    const h = channelOf(it.url)?.replace(/^[a-z]+:/, '')
    const bio = h ? bios[h] ?? '' : ''
    return bio ? { ...it, bio } : it
  })
}

// Deterministic safety net: a title literally containing one of its genre's
// terms is ALWAYS related, no matter what the LLM says. This stops obviously-
// related titles from slipping into the "unrelated" set when the model misses
// one (or a chunk returns a short/misaligned flag array). Matched against a
// normalized form (lowercased, all non-alphanumerics stripped) so "AI detector",
// "ai-detector" and "aidetector" all match the same key.
function keywordRelated(title: string, genre: Genre): boolean {
  return keywordHit(title, genre) !== null
}

/** The genre keyword the title contains, or null. */
function keywordHit(title: string, genre: Genre): string | null {
  const norm = title.toLowerCase().replace(/[^a-z0-9]/g, '')
  return GENRE_COPY[genre].related.keywords.find((k) => norm.includes(k)) ?? null
}

/**
 * One title's verdict, with WHICH PART OF THE PROMPT decided it — for the
 * admin's review.
 *
 *   rule      "topic": matched topic `ruleNo` of the genre's related-prompt
 *             "keyword": the title contains one of the genre's keywords, which
 *                        makes it related whatever the model says
 *             "none": matched none of the topics
 *   ruleText  that topic, or that keyword
 */
export type Verdict = {
  url: string
  related: boolean
  reason: string
  /** unanswered = the model never gave a verdict for it, even when asked again */
  rule: 'topic' | 'keyword' | 'none' | 'unanswered'
  ruleNo: number
  ruleText: string
}

/**
 * Judge these titles against the genre AND say why, one short sentence each.
 *
 * The keyword safety net still wins: a title containing a genre keyword is
 * related whatever the model says, and its reason then names the keyword.
 */
/**
 * Ask once: the verdicts the model gave, KEYED BY THE TITLE'S OWN NUMBER.
 *
 * Every answer names its title ("n"). Matching by position instead was safe
 * for 25 titles and not for a whole page: measured on 500, one call left a
 * title out, and by position every verdict after the gap would have landed on
 * the next link — silently, since a shifted list still has a verdict per row.
 */
async function askVerdicts(
  items: Item[],
  genre: Genre,
  topics: string[]
): Promise<Map<number, { ruleNo: number; reason: string }>> {
  const { content } = await llmChat({
    temperature: 0,
    jsonObject: true,
    // A sentence per title, plus room for a reasoning model's thinking.
    maxTokens: Math.min(60000, 2500 + items.length * 70),
    // A whole page is ~30 s on Flash-Lite; inside the route's 60.
    timeoutMs: 55_000,
    messages: [
      { role: 'system', content: classifyReasonSystem(genre) },
      { role: 'user', content: classifyUser(items) },
    ],
  })
  const got = new Map<number, { ruleNo: number; reason: string }>()
  try {
    const parsed = JSON.parse(content) as { items?: unknown }
    if (Array.isArray(parsed?.items)) {
      parsed.items.forEach((x, pos) => {
        const o = (x ?? {}) as { n?: unknown; rule?: unknown; reason?: unknown }
        // Its own number when given; position only for a reply without any.
        const num = Math.trunc(Number(o.n))
        const idx = Number.isFinite(num) && num >= 1 && num <= items.length ? num - 1 : pos
        if (got.has(idx)) return // a title answered twice: the first one stands
        const r = Math.trunc(Number(o.rule))
        got.set(idx, {
          // A number outside the list is no topic at all.
          ruleNo: Number.isFinite(r) && r >= 1 && r <= topics.length ? r : 0,
          reason: String(o.reason ?? '').trim().slice(0, 240),
        })
      })
    }
  } catch {
    /* no verdicts on a parse failure: every title is asked again or falls back */
  }
  return got
}

export async function classifyChunkWithReasons(items: Item[], genre: Genre = DEFAULT_GENRE): Promise<Verdict[]> {
  const { topics } = relatedCriteria(genre)
  // A failed call (overloaded, rate-limited, unparseable) is an empty answer,
  // not an error for the whole page: its titles are asked again below.
  const got = await askVerdicts(items, genre, topics).catch(() => new Map<number, { ruleNo: number; reason: string }>())
  // THE ONES IT SKIPPED — a few, or all of them when the call failed — are
  // asked again, twice at most, after a short pause.
  for (let round = 0; round < 2; round++) {
    const missing = items.map((_, i) => i).filter((i) => !got.has(i))
    if (missing.length === 0) break
    await new Promise((r) => setTimeout(r, 1500))
    const again = await askVerdicts(missing.map((i) => items[i]), genre, topics).catch(() => null)
    again?.forEach((v, j) => got.set(missing[j], v))
  }
  return items.map((it, i): Verdict => {
    const v = got.get(i)
    // RELATED IS THE RULE MATCHED, not a separate flag the model could set
    // against its own rule number.
    if (v && v.ruleNo > 0) {
      return {
        url: it.url, related: true, reason: v.reason || 'Matches the topic',
        rule: 'topic', ruleNo: v.ruleNo, ruleText: topics[v.ruleNo - 1],
      }
    }
    const kw = keywordHit(it.title, genre)
    if (kw) {
      return {
        url: it.url, related: true,
        reason: `The title contains "${kw}" — a keyword that always counts as related`,
        rule: 'keyword', ruleNo: 0, ruleText: kw,
      }
    }
    // NO ANSWER IS NOT "UNRELATED". It is kept apart so the page does not
    // tick a link for blocking that nobody — not even the model — has judged.
    if (!v) {
      return {
        url: it.url, related: false, reason: 'The model gave no answer for this title — not judged',
        rule: 'unanswered', ruleNo: 0, ruleText: '',
      }
    }
    return {
      url: it.url, related: false, reason: v.reason || 'Matches none of the topics',
      rule: 'none', ruleNo: 0, ruleText: '',
    }
  })
}

/** classifyRelatedByGenre with a reason for every title. */
export async function classifyWithReasonsByGenre(items: (Item & { genre?: string })[]): Promise<Verdict[]> {
  await ensureGenreRegistry().catch(() => {})
  const groups = new Map<Genre, Item[]>()
  for (const it of await withBios(items)) {
    const g = isGenre(it.genre) ? it.genre : DEFAULT_GENRE
    const list = groups.get(g) ?? []
    list.push({ url: it.url, title: it.title, bio: it.bio })
    groups.set(g, list)
  }
  // A WHOLE PAGE IN ONE REQUEST, as 100-title calls made ALL AT ONCE.
  //
  // Not one call of 500: measured, it took ~30 s when it worked, and twice in
  // three tries it did not — once failing outright, once answering 243 of 500.
  // A reply that long is where these models give out. 100 a call, in parallel,
  // is one wait of ~10 s; every answer names its title (askVerdicts), and the
  // few a call skips are asked again.
  const CHUNK = 100
  const calls: Promise<Verdict[]>[] = []
  for (const [g, list] of Array.from(groups.entries())) {
    for (let i = 0; i < list.length; i += CHUNK) {
      calls.push(classifyChunkWithReasons(list.slice(i, i + CHUNK), g))
    }
  }
  return (await Promise.all(calls)).flat()
}

// Ask the model which of these titles are related to this genre. Falls back to
// the next model on a quota/rate-limit error (see lib/llm.ts).
export async function classifyChunk(items: Item[], genre: Genre = DEFAULT_GENRE): Promise<string[]> {
  const { content } = await llmChat({
    temperature: 0,
    jsonObject: true,
    // A number per related title, plus room for a reasoning model's thinking.
    maxTokens: 1200 + items.length * 6,
    messages: [
      { role: 'system', content: classifySystem(genre) },
      { role: 'user', content: classifyUser(items) },
    ],
  })
  // The NUMBERS of the related titles (classifySystem). An old-style boolean
  // array is still read, by position, in case a model answers that way.
  const hit = new Set<number>()
  try {
    const parsed = JSON.parse(content) as { related?: unknown; flags?: unknown }
    if (Array.isArray(parsed?.related)) {
      for (const n of parsed.related) {
        const i = Math.trunc(Number(n)) - 1
        if (i >= 0 && i < items.length) hit.add(i)
      }
    } else if (Array.isArray(parsed?.flags)) {
      parsed.flags.forEach((f, i) => { if (f === true || f === 'true' || f === 1) hit.add(i) })
    }
  } catch {
    /* nothing related on a parse failure; the keyword net below still applies */
  }
  const urls: string[] = []
  items.forEach((it, i) => {
    // Related if EITHER the LLM named it OR it contains a known keyword.
    if (hit.has(i) || keywordRelated(it.title, genre)) urls.push(it.url)
  })
  return urls
}

/**
 * The subset of `items` whose titles are related to `genre`.
 *
 * Chunked because the providers count input AND output tokens against one
 * limit, and a long list of titles is mostly input.
 */
export async function classifyRelated(
  items: Item[],
  genre: Genre = DEFAULT_GENRE
): Promise<string[]> {
  // 100 titles a call on Gemini (30 on a Groq model), and the calls AT ONCE:
  // the answer is a list of numbers, so a long list cannot drift out of line.
  const CHUNK = (await llmTakesBigBatches().catch(() => false)) ? 100 : 30
  const chunks: Item[][] = []
  for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK))
  return (await Promise.all(chunks.map((c) => classifyChunk(c, genre)))).flat()
}

/**
 * The same, for a mixed list: each item judged against ITS OWN genre.
 *
 * One call per genre rather than one for the lot. The staging list can hold
 * several genres at once - it does right now - and asking one question of all
 * of them would mark the minority unrelated whichever question was picked.
 */
export async function classifyRelatedByGenre(
  items: (Item & { genre?: string })[]
): Promise<string[]> {
  // THE ADDED GENRES FIRST. Study helper is not built in: it exists in this
  // process only once the registry has been read. Without it isGenre said no,
  // every study link was asked "is this about AI humanizers?", and the button
  // marked nearly all of them unrelated — on a fresh server, which is most of
  // the time, and not on a warm one, which is why it looked random.
  await ensureGenreRegistry().catch(() => {})
  const groups = new Map<Genre, Item[]>()
  for (const it of await withBios(items)) {
    const g = isGenre(it.genre) ? it.genre : DEFAULT_GENRE
    const list = groups.get(g) ?? []
    list.push({ url: it.url, title: it.title, bio: it.bio })
    groups.set(g, list)
  }
  // The genres at once too, for the same reason.
  return (
    await Promise.all(Array.from(groups.entries()).map(([g, list]) => classifyRelated(list, g)))
  ).flat()
}
