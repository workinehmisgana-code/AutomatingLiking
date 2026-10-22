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
// lib/genreCopy.ts beside the rest of the domain copy.

import { llmChat } from './llm'
import { DEFAULT_GENRE, isGenre, type Genre } from './config'
import { GENRE_COPY } from './prompts'

export type Item = { url: string; title: string }

export function systemFor(genre: Genre): string {
  const { subject } = GENRE_COPY[genre].related
  return (
    'You classify short social-media video titles/captions. A title is RELATED when it is ' +
    `${subject}. ` +
    'Anything else is NOT related. ' +
    'Return STRICT JSON {"flags":[...]} where flags is a JSON array of booleans, ONE PER TITLE ' +
    'IN THE SAME ORDER \u2014 true if related, else false \u2014 with exactly as many booleans as titles. ' +
    'Example for 3 titles: {"flags":[true,false,true]}.'
  )
}

// Deterministic safety net: a title literally containing one of its genre's
// terms is ALWAYS related, no matter what the LLM says. This stops obviously-
// related titles from slipping into the "unrelated" set when the model misses
// one (or a chunk returns a short/misaligned flag array). Matched against a
// normalized form (lowercased, all non-alphanumerics stripped) so "AI detector",
// "ai-detector" and "aidetector" all match the same key.
function keywordRelated(title: string, genre: Genre): boolean {
  const norm = title.toLowerCase().replace(/[^a-z0-9]/g, '')
  return GENRE_COPY[genre].related.keywords.some((k) => norm.includes(k))
}

// Ask the model which of these titles are related to this genre. Falls back to
// the next model on a quota/rate-limit error (see lib/llm.ts).
export async function classifyChunk(items: Item[], genre: Genre = DEFAULT_GENRE): Promise<string[]> {
  const list = items.map((it, i) => `${i + 1}. ${it.title.slice(0, 200)}`).join('\n')
  const { content } = await llmChat({
    temperature: 0,
    jsonObject: true,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: systemFor(genre) },
      { role: 'user', content: `Titles:\n${list}` },
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
