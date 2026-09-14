// Moving links from the verify staging list into the main pool (videos.json).
//
// Lifted out of the admin route so the hourly channel harvest can merge without
// impersonating an admin over HTTP. One implementation, two callers: a second
// copy of this would drift, and the thing it would drift on is what the pool
// contains.

import { list, put } from '@vercel/blob'
import { platformFromUrl } from './config'
import {
  getVerifyLinksByUrls,
  getVerifyLinksByAccounts,
  deleteVerifyLinks,
  saveLinkTitles,
  getBlockedUrls,
} from './db'

export type Video = Record<string, unknown> & { url?: unknown }

export interface MergeResult {
  added: number
  updated: number
  removed: number
  skippedBlocked: number
  count: number
}

/** Dedup key: URL without query/trailing slash (TikTok links carry no ?v=). */
export function urlKey(v: Video): string {
  const raw = String(v.url ?? '').trim()
  return raw ? raw.split('?')[0].replace(/\/+$/, '') : ''
}

export async function loadVideos(): Promise<Video[]> {
  const { blobs } = await list({ prefix: 'videos.json' })
  if (!blobs.length) return []
  const res = await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? (data as Video[]) : []
}

/**
 * Merge verify-list links into the pool.
 *
 * Give it URLs, or channel handles to take everything those channels still have
 * staged. Returns what changed; merging nothing is not an error.
 */
export async function mergeVerifyLinks(opts: {
  urls?: string[]
  accounts?: string[]
}): Promise<MergeResult> {
  const urls = (opts.urls ?? []).map((u) => String(u ?? '').trim()).filter(Boolean)
  const accounts = (opts.accounts ?? []).map((a) => String(a ?? '').trim()).filter(Boolean)
  if (urls.length === 0 && accounts.length === 0) {
    return { added: 0, updated: 0, removed: 0, skippedBlocked: 0, count: 0 }
  }

  const allRows = accounts.length
    ? await getVerifyLinksByAccounts(accounts)
    : await getVerifyLinksByUrls(urls)
  if (allRows.length === 0) {
    return { added: 0, updated: 0, removed: 0, skippedBlocked: 0, count: 0 }
  }

  // A blocked link must never be merged back into the pool — every serve path
  // filters it out anyway, so it would be dead weight in videos.json and would
  // contradict the Links page, where it already reads as blocked. It still
  // LEAVES the verify list: blocking IS a decision, so it should not come back
  // for judging a second time.
  const blocked = new Set(await getBlockedUrls().catch(() => [] as string[]))
  const verifyRows = allRows.filter((r) => !blocked.has(r.url))
  const skippedBlocked = allRows.length - verifyRows.length
  const mergedUrls = allRows.map((r) => r.url)

  const now = new Date().toISOString()
  const incoming: Video[] = verifyRows.map((r) => ({
    url: r.url,
    platform: platformFromUrl(r.url),
    author: (r.account ?? '').replace(/^@/, ''),
    search_query: '',
    search_rank: 0, // no rank — clusters by posted date only
    like_count: r.heart_count,
    // Explicit LIKE count. TikTok's search grid only exposes views, so a link's
    // like_count means views for search-scraped links and likes for these —
    // indistinguishable once stored. Channel scrapes give the real diggCount, so
    // record it under its own name and let the scoring rely on it.
    heart_count: r.heart_count,
    posted_date: r.posted_date ?? '',
    scraped_at: now,
    date_only: true, // exclude from rank clusters, keep in date clusters
  }))

  // Append, de-duped by URL. A URL already in the pool keeps its stored row
  // (clicks, title, search rank and the rest stay intact) and only has its
  // engagement refreshed — and only with a valid positive value, so a scrape
  // that returned 0 never wipes a real count.
  const existing = await loadVideos()
  const byUrl = new Map<string, Video>()
  for (const v of existing) {
    const k = urlKey(v)
    if (k) byUrl.set(k, v)
  }
  let added = 0
  let updated = 0
  for (const v of incoming) {
    const k = urlKey(v)
    if (!k) continue
    const stored = byUrl.get(k)
    if (!stored) {
      byUrl.set(k, v)
      added++
      continue
    }
    let changed = false
    const nextLikes = Number(v.like_count)
    if (Number.isFinite(nextLikes) && nextLikes > 0 && nextLikes !== Number(stored.like_count)) {
      stored.like_count = nextLikes
      changed = true
    }
    // Backfill the real like count on rows merged before heart_count was written
    // here. Without this the field only ever lands on newly-inserted rows.
    const nextHearts = Number(v.heart_count)
    if (Number.isFinite(nextHearts) && nextHearts > 0 && nextHearts !== Number(stored.heart_count)) {
      stored.heart_count = nextHearts
      changed = true
    }
    if (!String(stored.posted_date ?? '') && String(v.posted_date ?? '')) {
      stored.posted_date = v.posted_date
      changed = true
    }
    if (changed) updated++
  }

  const videos = Array.from(byUrl.values())
  await put('videos.json', JSON.stringify(videos), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  })

  // Cache their titles so the main list shows them, then drop from the verify list.
  const titles: Record<string, string> = {}
  for (const r of verifyRows) if (r.title) titles[r.url] = r.title
  await saveLinkTitles(titles).catch(() => {})
  const removed = await deleteVerifyLinks(mergedUrls)

  return { added, updated, removed, skippedBlocked, count: videos.length }
}
