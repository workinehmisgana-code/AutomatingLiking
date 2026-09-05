import {
  type Product,
  isProduct,
  GROQ_MODEL,
  GROQ_BASE_URL,
  PROMO_TITLE_COUNT,
  PROMO_REFRESH_MS,
  PROMO_MANDATORY_TAGS,
  PROMO_EXTRA_TAG_MAX,
} from './config'
import {
  getGeneratedPromo,
  saveGeneratedPromo,
  acquirePromoLock,
  releasePromoLock,
} from './db'

const LOCK_LEASE_MS = 2 * 60 * 1000

function cleanTitle(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim().replace(/^["'\s]+|["'\s]+$/g, '')
  if (!t) return null
  if (t.length > 120) return null // captions should be short-ish
  return t
}

function cleanTag(s: unknown): string | null {
  if (typeof s !== 'string') return null
  let t = s.trim().replace(/\s+/g, '')
  if (!t) return null
  if (!t.startsWith('#')) t = '#' + t.replace(/^#+/, '')
  if (t.length < 2 || t.length > 40) return null
  return t
}

// Ask Groq to generate promo caption titles + extra hashtags for a product.
async function callGroq(product: Product): Promise<{ titles: string[]; tags: string[] }> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY is not set')

  const mandatory = PROMO_MANDATORY_TAGS.join(' ')
  const system =
    `"${product}" is an AI humanizer website — it rewrites AI text so it reads as human and ` +
    `bypasses every AI detector (Turnitin, GPTZero, Originality, Copyleaks, ZeroGPT). It is the ` +
    `best humanizer right now. Generate short, catchy social-media video captions/titles that ` +
    `advertise "${product}" in that light (best humanizer, beats all detectors, 0% AI), and a set ` +
    `of extra relevant hashtags. Rules: titles are 4-12 words, catchy, lowercase-ish casual, no ` +
    `surrounding quotes, no emojis; do NOT include hashtags inside the titles. Extra tags are ` +
    `single hashtags (start with #, no spaces) that are relevant to AI writing / students / ` +
    `humanizers; do NOT repeat these already-required tags: ${mandatory}. ` +
    `Return strict JSON: {"titles": ["...", ...], "tags": ["#...", ...]} with ${PROMO_TITLE_COUNT} ` +
    `titles and AT MOST ${PROMO_EXTRA_TAG_MAX} extra tags.`

  const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
      max_completion_tokens: 2000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Generate captions and tags for "${product}".` },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Groq ${res.status}: ${detail.slice(0, 300)}`)
  }
  const data = await res.json()
  const content: string = data?.choices?.[0]?.message?.content ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Groq returned non-JSON content')
  }
  const p = parsed as { titles?: unknown; tags?: unknown }

  const seenT = new Set<string>()
  const titles: string[] = []
  for (const raw of Array.isArray(p.titles) ? p.titles : []) {
    const t = cleanTitle(raw)
    if (t && !seenT.has(t.toLowerCase())) {
      seenT.add(t.toLowerCase())
      titles.push(t)
    }
  }

  const mandatoryLower = new Set(PROMO_MANDATORY_TAGS.map((t) => t.toLowerCase()))
  const seenTag = new Set<string>()
  const tags: string[] = []
  for (const raw of Array.isArray(p.tags) ? p.tags : []) {
    const t = cleanTag(raw)
    if (t && !mandatoryLower.has(t.toLowerCase()) && !seenTag.has(t.toLowerCase())) {
      seenTag.add(t.toLowerCase())
      tags.push(t)
    }
  }

  if (titles.length === 0) throw new Error('No valid titles returned')
  // Never keep more than the allowed number of extra tags.
  return { titles, tags: tags.slice(0, PROMO_EXTRA_TAG_MAX) }
}

export async function regeneratePromo(product: Product): Promise<number> {
  const { titles, tags } = await callGroq(product)
  await saveGeneratedPromo(product, titles, tags)
  return titles.length
}

/**
 * Return the promo caption titles + AI extra tags for a product, regenerating
 * first if missing or older than the refresh window. Only one request
 * regenerates at a time; others get the cache. Falls back to a single generic
 * title if generation fails and nothing is stored.
 */
export async function getFreshPromo(
  product: string
): Promise<{ titles: string[]; extraTags: string[]; generatedAt: string | null }> {
  if (!isProduct(product)) return { titles: [], extraTags: [], generatedAt: null }

  const current = await getGeneratedPromo(product)
  const age = current?.generated_at ? Date.now() - new Date(current.generated_at).getTime() : Infinity
  const stale = !current || current.titles.length === 0 || age > PROMO_REFRESH_MS

  if (stale) {
    const won = await acquirePromoLock(product, LOCK_LEASE_MS)
    if (won) {
      try {
        await regeneratePromo(product)
        const saved = await getGeneratedPromo(product)
        if (saved && saved.titles.length > 0) {
          return {
            titles: saved.titles,
            extraTags: saved.extraTags,
            generatedAt: saved.generated_at ? new Date(saved.generated_at).toISOString() : null,
          }
        }
      } catch {
        /* fall through to cache / fallback */
      } finally {
        await releasePromoLock(product).catch(() => {})
      }
    }
  }

  if (current && current.titles.length > 0) {
    return {
      titles: current.titles,
      extraTags: current.extraTags,
      generatedAt: current.generated_at ? new Date(current.generated_at).toISOString() : null,
    }
  }
  // Nothing generated yet — a single generic caption keeps the page usable.
  return {
    titles: [`${product} is the best ai humanizer, beats every detector`],
    extraTags: [],
    generatedAt: null,
  }
}
