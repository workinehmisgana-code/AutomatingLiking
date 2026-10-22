import { list } from '@vercel/blob'
import { cached, invalidate, TTL } from './poolCache'
import { DEFAULT_GENRE, genreOfRow, repairRowPlatform } from './config'
import { retireThreshold } from './config'

export interface RawVideo {
  url: string
  platform?: string
  search_query?: string
  search_rank?: number
  posted_date?: string
  scraped_at?: string
  like_count?: number
  /**
   * Which genre's pool this link belongs to — 'humanizer' | 'website' | 'slides'.
   *
   * ABSENT ON MOST OF THE POOL and that is permanent: every link scraped before
   * genres existed is a humanizer link, and there are tens of thousands of them.
   * Read it with genreOfRow() from lib/config, never directly, so an absent one
   * is DEFAULT_GENRE everywhere rather than humanizer on one screen and
   * undefined on the next.
   */
  genre?: string
  date_only?: boolean // merged verify-links: no rank, cluster by posted date only
  date_score?: number // composite posted-date score, set at upload (lib/dateScore.ts)
  // The score's three parts: recency percentile, 1/0 for video, hearts percentile.
  ds_r?: number
  ds_v?: number
  ds_h?: number
}

// Load the scraped link dataset (videos.json) from Vercel Blob.
export async function loadVideosJson(): Promise<RawVideo[]> {
  // THE WHOLE POOL, OVER THE NETWORK, PER REQUEST. This downloads videos.json
  // from blob storage with `cache: 'no-store'`, and both the worker feed and
  // every admin links view call it on every request. The file holds the entire
  // link pool, so that is tens of megabytes fetched to answer a question the
  // same fetch answered a second ago.
  //
  // It is replaced by an upload or a merge, minutes to days apart, and both call
  // invalidatePoolFile() — so the only staleness left is the TTL, and the only
  // cost left is one download per instance per five minutes.
  return cached('videosJson', TTL.pool, loadVideosJsonUncached)
}

export function invalidatePoolFile(): void {
  invalidate('videosJson')
  // The genre index is derived from the same blob, so it goes stale at exactly
  // the same moment. Forgetting it here would mean a link uploaded into the
  // website pool kept being served humanizer comments until the TTL lapsed.
  invalidate('poolGenres')
}

/**
 * Which genre's pool one URL belongs to.
 *
 * LOOKED UP SERVER-SIDE ON PURPOSE. The click routes take the product from the
 * client when it is given one, which is fine — a wrong product costs one
 * mis-attributed click. The genre is different: it decides which product's
 * comment a worker is told to paste, and a cocodly comment under a humanizer
 * video (or the reverse) is a stranger talking about something else. So it is
 * read from the pool rather than taken on trust.
 *
 * Indexed once per pool fetch, against the same TTL: the blob is already
 * downloaded in full on these paths, and a Map over it costs a fraction of that.
 */
export async function genreOfUrl(url: string): Promise<string> {
  if (!url) return DEFAULT_GENRE
  const index = await getPoolGenreIndex()
  // A URL the pool has never heard of is the default, not an error: a click can
  // arrive for a link that has just been removed, and the honest answer there is
  // the same one every pre-genre link gets.
  return index.get(url) ?? DEFAULT_GENRE
}

/**
 * Every pool URL → its genre. Indexed once per pool fetch, against the same
 * TTL. Also what decides which genre's block applies to a pool link: blocks
 * are per genre (blocked_link.genre), and a link is served in exactly one.
 */
export function getPoolGenreIndex(): Promise<Map<string, string>> {
  return cached('poolGenres', TTL.pool, async () => {
    const rows = await loadVideosJson().catch(() => [] as RawVideo[])
    const m = new Map<string, string>()
    for (const r of rows) {
      const u = String(r?.url ?? '')
      if (u) m.set(u, genreOfRow(r))
    }
    return m
  }).catch(() => new Map<string, string>())
}

async function loadVideosJsonUncached(): Promise<RawVideo[]> {
  try {
    const { blobs } = await list({ prefix: 'videos.json' })
    if (!blobs.length) return []
    const res = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? (data as RawVideo[]).map(repairRowPlatform) : []
  } catch {
    return []
  }
}

// Which link URLs are retired, given the per-URL distinct-user click counts.
// A link is retired once its clicks reach its engagement-based threshold.
//
// `retirePlatforms` is the set of platforms where retirement is actually on — the
// master switch AND that platform's own retirement switch (see
// getEffectivePlatformLimits). Links on any other platform never retire. This is
// independent of the per-platform HOURLY quota switches, which don't affect
// retirement at all.
export function retiredUrlSet(
  videos: RawVideo[],
  clickCounts: Record<string, number>,
  retirePlatforms: Set<string>
): Set<string> {
  const out = new Set<string>()
  for (const v of videos) {
    const url = v.url
    if (!url) continue
    const platform = String(v.platform ?? '')
    if (!retirePlatforms.has(platform)) continue
    const n = clickCounts[url] ?? 0
    if (n > 0 && n >= retireThreshold(platform, Number(v.like_count ?? 0))) {
      out.add(url)
    }
  }
  return out
}
