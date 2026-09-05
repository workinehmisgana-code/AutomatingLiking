import { list } from '@vercel/blob'
import { retireThreshold } from './config'

export interface RawVideo {
  url: string
  platform?: string
  search_query?: string
  search_rank?: number
  posted_date?: string
  scraped_at?: string
  like_count?: number
  date_only?: boolean // merged verify-links: no rank, cluster by posted date only
  date_score?: number // composite posted-date score, set at upload (lib/dateScore.ts)
  // The score's three parts: recency percentile, 1/0 for video, hearts percentile.
  ds_r?: number
  ds_v?: number
  ds_h?: number
}

// Load the scraped link dataset (videos.json) from Vercel Blob.
export async function loadVideosJson(): Promise<RawVideo[]> {
  try {
    const { blobs } = await list({ prefix: 'videos.json' })
    if (!blobs.length) return []
    const res = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? (data as RawVideo[]) : []
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
