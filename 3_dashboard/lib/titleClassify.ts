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

import { llmChat } from './llm'
import { DEFAULT_GENRE, isGenre, type Genre } from './config'
import { GENRE_COPY, classifyReasonSystem, classifySystem, classifyUser } from './prompts'
import { ensureGenreRegistry } from './genreStore'

export type Item = { url: string; title: string }

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

/** One title's verdict, with why — for the admin's review. */
export type Verdict = { url: string; related: boolean; reason: string }

/**
 * Judge these titles against the genre AND say why, one short sentence each.
 *
 * The keyword safety net still wins: a title containing a genre keyword is
 * related whatever the model says, and its reason then names the keyword.
 */
export async function classifyChunkWithReasons(items: Item[], genre: Genre = DEFAULT_GENRE): Promise<Verdict[]> {
  const { content } = await llmChat({
    temperature: 0,
    jsonObject: true,
    // A sentence per title, plus room for a reasoning model's thinking.
    maxTokens: Math.min(8000, 2500 + items.length * 60),
    messages: [
      { role: 'system', content: classifyReasonSystem(genre) },
      { role: 'user', content: classifyUser(items.map((it) => it.title)) },
    ],
  })
  let out: { related: boolean; reason: string }[] = []
  try {
    const parsed = JSON.parse(content) as { items?: unknown }
    if (Array.isArray(parsed?.items)) {
      out = parsed.items.map((x) => {
        const o = (x ?? {}) as { related?: unknown; reason?: unknown }
        return {
          related: o.related === true || o.related === 'true' || o.related === 1,
          reason: String(o.reason ?? '').trim().slice(0, 240),
        }
      })
    }
  } catch {
    /* no verdicts on a parse failure: every title falls back below */
  }
  return items.map((it, i) => {
    const v = out[i]
    const kw = keywordHit(it.title, genre)
    if (kw && !v?.related) {
      return { url: it.url, related: true, reason: `Mentions "${kw}", one of this genre's keywords` }
    }
    if (!v) return { url: it.url, related: false, reason: 'The model gave no answer for this title' }
    return { url: it.url, related: v.related, reason: v.reason || (v.related ? 'Related' : 'Not related') }
  })
}

/** classifyRelatedByGenre with a reason for every title. */
export async function classifyWithReasonsByGenre(items: (Item & { genre?: string })[]): Promise<Verdict[]> {
  await ensureGenreRegistry().catch(() => {})
  const groups = new Map<Genre, Item[]>()
  for (const it of items) {
    const g = isGenre(it.genre) ? it.genre : DEFAULT_GENRE
    const list = groups.get(g) ?? []
    list.push({ url: it.url, title: it.title })
    groups.set(g, list)
  }
  const CHUNK = 25
  const out: Verdict[] = []
  for (const [g, list] of Array.from(groups.entries())) {
    for (let i = 0; i < list.length; i += CHUNK) {
      out.push(...(await classifyChunkWithReasons(list.slice(i, i + CHUNK), g)))
    }
  }
  return out
}

// Ask the model which of these titles are related to this genre. Falls back to
// the next model on a quota/rate-limit error (see lib/llm.ts).
export async function classifyChunk(items: Item[], genre: Genre = DEFAULT_GENRE): Promise<string[]> {
  const { content } = await llmChat({
    temperature: 0,
    jsonObject: true,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: classifySystem(genre) },
      { role: 'user', content: classifyUser(items.map((it) => it.title)) },
    ],
  })
  let flags: boolean[] = []
  try {
    const parsed = JSON.parse(content) as { flags?: unknown }
    if (Array.isArray(parsed?.flags)) flags = parsed.flags.map((f) => f === true || f === 'true' || f === 1)
  } catch {
    /* leave flags empty on parse failure */
  }
  const urls: string[] = []
  items.forEach((it, i) => {
    // Related if EITHER the LLM flagged it OR it contains a known keyword.
    if (flags[i] || keywordRelated(it.title, genre)) urls.push(it.url)
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
  const CHUNK = 30
  const related: string[] = []
  for (let i = 0; i < items.length; i += CHUNK) {
    related.push(...(await classifyChunk(items.slice(i, i + CHUNK), genre)))
  }
  return related
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
  for (const it of items) {
    const g = isGenre(it.genre) ? it.genre : DEFAULT_GENRE
    const list = groups.get(g) ?? []
    list.push({ url: it.url, title: it.title })
    groups.set(g, list)
  }
  const related: string[] = []
  for (const [g, list] of Array.from(groups.entries())) {
    related.push(...(await classifyRelated(list, g)))
  }
  return related
}
