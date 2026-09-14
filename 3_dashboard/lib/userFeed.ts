import { parsePostedDate } from './cluster'
import { RANK_CLUSTER_COUNT, DATE_CLUSTER_COUNT } from './config'

// The slice of the pool one user is actually given.
//
// The dashboard used to receive videos.json whole — 129k links, tens of
// megabytes — and cluster it in the browser. Every page load shipped the entire
// pool to a phone so it could show the first twenty links, and the hourly quota
// is twenty links per platform per hour: a user can never reach past the first
// page of it.
//
// So the cut is made here. Two things have to survive it, or the list a user
// works through would change meaning:
//
//   THE CLUSTER NUMBERS. A cluster is an equal-count chunk of the platform's
//   WHOLE set. Cutting first and clustering after would spread 100 links across
//   30 clusters and call the best one "cluster 1" no matter how bad it was.
//   Every link is therefore clustered against the full set, and carries the
//   number it earned there.
//
//   BOTH DIMENSIONS. A user is assigned search-rank or posted-date ordering,
//   and the dashboard lets them switch. Cutting on one dimension would leave
//   the other tab empty, so the cut is the UNION of the best `perPlatform` of
//   each — at most twice the cap per platform, still four orders of magnitude
//   less than the pool.
//
// Links the user has already opened, and links retired globally, are dropped
// BEFORE the cut, so the cap is a hundred links they can work on rather than a
// hundred rows that might all be spent.

/** What the page needs of a video to place it. Structural, so both the server's
 *  raw JSON rows and the client's Video satisfy it. */
export interface FeedVideo {
  url: string
  platform: string
  posted_date?: string
  scraped_at?: string
  search_rank?: number
  date_score?: number
}

/** The placement a link earned in the full pool, carried alongside it. */
export interface FeedPlacement {
  /** Cluster index (0-based) in the search-rank clustering; -1 = unranked. */
  rankCluster: number
  /** Position in search-rank order across the platform; -1 = unranked. */
  rankPos: number
  /** Cluster index (0-based) in the posted-date clustering; -1 = undated. */
  dateCluster: number
  /** Position in posted-date order across the platform; -1 = undated. */
  datePos: number
}

export const FEED_PER_PLATFORM = 100

/** Chunk index for position `idx` of `total`, matching the dashboard's rule. */
function chunk(idx: number, total: number, n: number): number {
  return total ? Math.min(n - 1, Math.floor((idx * n) / total)) : 0
}

/**
 * Order one platform's links by both dimensions and keep the best `perPlatform`
 * of each, stamped with where they sit in the full set.
 *
 * `skip` is consulted before the cut, not after.
 */
function forPlatform<T extends FeedVideo>(
  base: T[],
  skip: (v: T) => boolean,
  perPlatform: number
): (T & FeedPlacement)[] {
  const placement = new Map<string, FeedPlacement>()
  const place = (url: string): FeedPlacement => {
    let p = placement.get(url)
    if (!p) {
      p = { rankCluster: -1, rankPos: -1, dateCluster: -1, datePos: -1 }
      placement.set(url, p)
    }
    return p
  }

  const ranked = base
    .filter((v) => Number(v.search_rank) > 0)
    .sort((a, b) => Number(a.search_rank) - Number(b.search_rank))
  ranked.forEach((v, i) => {
    const p = place(v.url)
    p.rankCluster = chunk(i, ranked.length, RANK_CLUSTER_COUNT)
    p.rankPos = i
  })

  // The composite posted-date score when the pool carries one, else plain
  // recency — the same fallback the dashboard used, so an older pool that was
  // never rescored still clusters by date instead of collapsing to one bucket.
  const useScore = base.some((v) => typeof v.date_score === 'number')
  const dated = base
    .map((v) => ({
      v,
      ts: useScore
        ? typeof v.date_score === 'number'
          ? v.date_score
          : null
        : parsePostedDate(v.posted_date, v.scraped_at),
    }))
    .filter((x): x is { v: T; ts: number } => x.ts !== null)
    .sort((a, b) => b.ts - a.ts)
  dated.forEach((x, i) => {
    const p = place(x.v.url)
    p.dateCluster = chunk(i, dated.length, DATE_CLUSTER_COUNT)
    p.datePos = i
  })

  const out = new Map<string, T & FeedPlacement>()
  const take = (list: T[]) => {
    let n = 0
    for (const v of list) {
      if (n >= perPlatform) break
      if (skip(v)) continue
      n++
      if (!out.has(v.url)) out.set(v.url, { ...v, ...place(v.url) })
    }
  }
  take(ranked)
  take(dated.map((x) => x.v))
  // A link with neither a rank nor a date still has to be reachable, or a pool
  // with no scores at all would serve nothing. It fills what the two orderings
  // left, and never displaces a placed link.
  if (out.size < perPlatform) {
    for (const v of base) {
      if (out.size >= perPlatform) break
      if (skip(v) || out.has(v.url)) continue
      out.set(v.url, { ...v, ...place(v.url) })
    }
  }
  return Array.from(out.values())
}

/**
 * Cut the pool down to what one user is served: the best `perPlatform` links of
 * each dimension, per platform, already stamped with their place in the full
 * pool. `skipUrls` are the links this user has opened plus the retired ones.
 */
export function buildUserFeed<T extends FeedVideo>(
  videos: T[],
  skipUrls: Set<string>,
  perPlatform: number = FEED_PER_PLATFORM
): { served: (T & FeedPlacement)[]; remaining: Record<string, number> } {
  const byPlatform = new Map<string, T[]>()
  for (const v of videos) {
    const k = String(v.platform ?? 'unknown')
    const list = byPlatform.get(k)
    if (list) list.push(v)
    else byPlatform.set(k, [v])
  }
  const skip = (v: T) => skipUrls.has(v.url)
  const served: (T & FeedPlacement)[] = []
  // How many links a platform really has left for this user. The page shows
  // this on the tabs and in the header, and it must be the TRUE figure — after
  // the cut the served list is capped, so counting it would tell every user
  // they have a hundred links left forever.
  const remaining: Record<string, number> = {}
  for (const [key, list] of Array.from(byPlatform.entries())) {
    served.push(...forPlatform(list, skip, perPlatform))
    remaining[key] = list.reduce((n, v) => (skip(v) ? n : n + 1), 0)
  }
  return { served, remaining }
}
