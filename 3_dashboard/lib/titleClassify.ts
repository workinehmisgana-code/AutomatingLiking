// Is a video title about AI humanizers / AI detectors?
//
// Lifted out of the admin route so the hourly channel harvest classifies by
// exactly the same rules the "Mark humanizer related" button uses. Two copies of
// this would drift, and the thing they would drift on is which links reach the
// pool without anyone looking at them.

import { groqChat } from './groq'

export type Item = { url: string; title: string }

const SYSTEM =
  'You classify short social-media video titles/captions. A title is RELATED when it is ' +
  'about any of these topics/brands: humanizer, AI detector, AI detectors, NaturalWrite (the ' +
  'humanizer), GrubbyAI (the humanizer), WalterWritesAI (the humanizer), Undetectable AI, ' +
  'AI humanizer, Turnitin (the AI detector), GPTZero (the AI detector), Originality AI (the ' +
  'detector), AI detection, or humanize (humanizing AI-generated text so it reads as human / ' +
  'bypasses AI detectors). Anything else is NOT related. ' +
  'Return STRICT JSON {"flags":[...]} where flags is a JSON array of booleans, ONE PER TITLE ' +
  'IN THE SAME ORDER — true if related, else false — with exactly as many booleans as titles. ' +
  'Example for 3 titles: {"flags":[true,false,true]}.'

// Deterministic safety net: a title literally containing one of these terms is
// ALWAYS related, no matter what the LLM says. This stops obviously-related
// titles from slipping into the "unrelated" set when the model misses one (or a
// chunk returns a short/misaligned flag array). Matched against a normalized
// form (lowercased, all non-alphanumerics stripped) so "AI detector", "ai-detector"
// and "aidetector" all match the same key.
const RELATED_KEYWORDS = [
  'humanizer', // covers "ai humanizer"
  'humanize',
  'aidetector', // covers "ai detectors"
  'aidetection',
  'naturalwrite',
  'grubbyai',
  'walterwrites', // covers "walter writes ai"
  'undetectableai',
  'turnitin',
  'gptzero',
  'originalityai',
  "bypassai",
  "bypassgpt",
  "#essay",
  "essayhacks",
  "essaytips",
  "essaywriting",
]

function keywordRelated(title: string): boolean {
  const norm = title.toLowerCase().replace(/[^a-z0-9]/g, '')
  return RELATED_KEYWORDS.some((k) => norm.includes(k))
}

// Ask Groq which of these titles are humanizer / AI-detector related. Falls back
// to the next model on a quota/rate-limit error (see lib/groq.ts).
export async function classifyChunk(items: Item[]): Promise<string[]> {
  const list = items.map((it, i) => `${i + 1}. ${it.title.slice(0, 200)}`).join('\n')
  const { content } = await groqChat({
    temperature: 0,
    jsonObject: true,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: SYSTEM },
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
    if (flags[i] || keywordRelated(it.title)) urls.push(it.url)
  })
  return urls
}

/**
 * The subset of `items` whose titles are humanizer / AI-detector related.
 *
 * Chunked because Groq counts input AND output tokens against one limit, and a
 * long list of titles is mostly input.
 */
export async function classifyRelated(items: Item[]): Promise<string[]> {
  const CHUNK = 30
  const related: string[] = []
  for (let i = 0; i < items.length; i += CHUNK) {
    related.push(...(await classifyChunk(items.slice(i, i + CHUNK))))
  }
  return related
}
