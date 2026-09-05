// Sorting links into one audience (competitors / ai_detector / generic).
//
// Lifted out of the admin route so the automatic pipeline runs exactly the same
// classification the button does.
//
// ONLY LINKS THAT HAVE NO CATEGORY YET. There is no cursor and none is needed:
// each call takes the next slice of UNcategorised links, and categorising them
// removes them from the set, so the following call continues by itself. Blocked
// links are excluded — categorising a link nobody will be served is wasted quota.

import { loadVideosJson } from './videos'
import {
  getLinkTitles,
  getLinkCategories,
  saveLinkCategories,
  countLinkCategories,
  getChannelBios,
  harvestChannelBios,
  getBlockedUrls,
} from './db'
import { categorizeChunk, CHUNK, type Categorizable } from './linkCategory'
import { handleOf } from './channelRank'

/** Prompts in flight. Groq rate-limits, and lib/groq.ts already falls back. */
const CONCURRENCY = 3
/** Chunks queued per call. Enough to fill the workers for one budget. */
const CHUNKS_PER_CALL = CONCURRENCY * 4

/** Every servable link, with the text the classifier reads. */
export async function allTargets(): Promise<Categorizable[]> {
  const [videos, titles, bios, blockedUrls] = await Promise.all([
    loadVideosJson().catch(() => []),
    getLinkTitles().catch(() => ({}) as Record<string, string>),
    getChannelBios().catch(() => ({}) as Record<string, string>),
    getBlockedUrls().catch(() => [] as string[]),
  ])
  const blocked = new Set(blockedUrls)
  const out: Categorizable[] = []
  for (const v of videos) {
    const url = String(v.url ?? '')
    if (!url.startsWith('http') || blocked.has(url)) continue
    const handle = handleOf(url)
    out.push({ url, title: titles[url] ?? '', bio: (handle && bios[handle]) || '' })
  }
  // Stable order so repeated runs work through the backlog the same way.
  out.sort((a, b) => a.url.localeCompare(b.url))
  return out
}

/** Only those without a decision yet. */
export async function pendingTargets(): Promise<{ pending: Categorizable[]; total: number }> {
  const all = await allTargets()
  const decided = await getLinkCategories().catch(() => ({}) as Record<string, string>)
  return { pending: all.filter((t) => !decided[t.url]), total: all.length }
}

export interface CategoriseResult {
  total: number
  poolTotal: number
  processed: number
  saved: number
  remaining: number
  done: boolean
  counts: Record<string, number>
}

/** Categorise as many pending links as fit before `deadline`. */
export async function categorizeSome(deadline: number): Promise<CategoriseResult> {
  // Bios live per-link in the verify list and are dropped by a merge, so lift
  // them into channel_bio first. Cheap, and it means a channel scraped today
  // informs links merged months ago.
  await harvestChannelBios().catch(() => 0)

  const { pending, total } = await pendingTargets()
  if (pending.length === 0) {
    return {
      total: 0,
      poolTotal: total,
      processed: 0,
      saved: 0,
      remaining: 0,
      done: true,
      counts: await countLinkCategories().catch(() => ({})),
    }
  }

  const chunks: Categorizable[][] = []
  for (let i = 0; i < pending.length && chunks.length < CHUNKS_PER_CALL; i += CHUNK) {
    chunks.push(pending.slice(i, i + CHUNK))
  }

  const decided: { url: string; category: string }[] = []
  let next = 0
  const worker = async () => {
    for (;;) {
      // At least one chunk always runs, or a slow caller could leave this doing
      // nothing and the loop would spin without progress.
      if (decided.length > 0 && Date.now() >= deadline) return
      const i = next++
      if (i >= chunks.length) return
      const chunk = chunks[i]
      const cats = await categorizeChunk(chunk)
      chunk.forEach((it, k) => decided.push({ url: it.url, category: cats[k] }))
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const saved = await saveLinkCategories(decided)
  const remaining = pending.length - decided.length
  return {
    total: pending.length,
    poolTotal: total,
    processed: decided.length,
    saved,
    remaining,
    done: remaining <= 0,
    counts: await countLinkCategories().catch(() => ({})),
  }
}
