import {
  type Product,
  isProduct,
  PROMO_TITLE_COUNT,
  PROMO_REFRESH_MS,
  PROMO_MANDATORY_TAGS,
  PROMO_EXTRA_TAG_MAX,
} from './config'
import { llmChat } from './llm'
import { promoSystem } from './prompts'
import { copyForProduct, withProduct } from './prompts'
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

/**
 * Ask the model for promo caption titles + extra hashtags for a product.
 *
 * THROUGH THE SHARED CLIENT, like everything else. This used to open its own
 * connection to Groq with the model name compiled in, so the admin's model
 * setting governed six generation paths and silently not this one — switching
 * the app to Gemini would have left promo captions on Groq, and only a reader
 * of this file would ever have known.
 */
async function callModel(product: Product): Promise<{ titles: string[]; tags: string[] }> {
  const mandatory = PROMO_MANDATORY_TAGS.join(' ')
  // WHAT THE PRODUCT IS, and what a caption should boast about, come from the
  // genre table. Hardcoding the humanizer pitch here would have a worker
  // reposting a video captioned "beats every AI detector" about a slide maker.
  const brief = withProduct(copyForProduct(product).promo, product)
  const system = promoSystem(brief, mandatory)

  const { content, model } = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Generate captions and tags for "${product}".` },
    ],
    temperature: 0.9,
    jsonObject: true,
    maxTokens: 2000,
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`${model} returned non-JSON content`)
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
  const { titles, tags } = await callModel(product)
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
