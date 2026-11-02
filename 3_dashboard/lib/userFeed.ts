import { parsePostedDate } from './cluster'
import {
  DATE_CLUSTER_COUNT,
  GENRES,
  genreOfRow,
  genreWeights,
  RANK_CLUSTER_COUNT,
} from './config'

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
  /** Which genre's pool this link is in; absent reads as the default. */
  genre?: string
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
/**
 * The largest block: the genre with the biggest share serves this many links
 * in a row before the list moves to another genre.
 */
export const GENRE_BLOCK = 10
/** No block is shorter than this, however small its genre's share. */
export const GENRE_BLOCK_MIN = 3

/**
 * How many links in a row each genre serves: GENRE_BLOCK for the biggest
 * share, the rest IN PROPORTION — at 60/20/20 that is 10, 3, 3 — never under
 * GENRE_BLOCK_MIN. A small share gets a short block that comes round less
 * often, rather than a long one that comes round rarely.
 */
export function genreBlockSizes(weights: Record<string, number>): Record<string, number> {
  const max = Math.max(0, ...Object.values(weights).filter((w) => w > 0))
  const out: Record<string, number> = {}
  for (const [g, w] of Object.entries(weights)) {
    out[g] = w > 0 && max > 0
      ? Math.max(GENRE_BLOCK_MIN, Math.min(GENRE_BLOCK, Math.round((GENRE_BLOCK * w) / max)))
      : 0
  }
  return out
}

/**
 * Draw from several ordered lists in a target ratio, ONE GENRE AT A TIME.
 *
 * IN BLOCKS, NOT SHUFFLED. A worker given humanizer, slides, study, humanizer…
 * link after link has a different product and a different comment every time,
 * and the comment for one video ends up pasted under the next. So a genre
 * serves a block of links in a row (genreBlockSizes) before the list moves on.
 *
 * WHICH GENRE NEXT: the one furthest behind its share — fewest links taken for
 * its weight — so over any long stretch the shares come out as the mix says.
 * Ties go to the first in insertion order (GENRES order: humanizer first).
 *
 * IT REMEMBERS WHERE THE WORKER IS. `history` is the genres of their recent
 * clicks on this platform, newest first. Without it every reload would start a
 * fresh humanizer block and the other genres would never come round: the run
 * in progress is finished first, and the shares are counted from what they
 * have already opened.
 *
 * A GENRE THAT RUNS DRY YIELDS ITS SLOTS: it stops being eligible and the
 * others fill the list. Deterministic, so a reload gives the same list.
 */
export function interleaveByWeight<T>(
  lists: Map<string, T[]>,
  weights: Record<string, number>,
  limit: number,
  history: string[] = []
): T[] {
  const sizes = genreBlockSizes(weights)
  const at = new Map<string, number>()
  const taken = new Map<string, number>()
  for (const k of Array.from(lists.keys())) {
    at.set(k, 0)
    taken.set(k, 0)
  }
  for (const g of history) if (taken.has(g)) taken.set(g, (taken.get(g) ?? 0) + 1)
  const eligible = (k: string) =>
    (weights[k] ?? 0) > 0 && (at.get(k) ?? 0) < (lists.get(k)?.length ?? 0)
  const out: T[] = []
  const take = (k: string, n: number) => {
    const list = lists.get(k) as T[]
    while (n-- > 0 && out.length < limit && (at.get(k) ?? 0) < list.length) {
      out.push(list[at.get(k) ?? 0])
      at.set(k, (at.get(k) ?? 0) + 1)
      taken.set(k, (taken.get(k) ?? 0) + 1)
    }
  }
  // Finish the block the worker is in the middle of.
  if (history.length > 0) {
    const g = history[0]
    let run = 0
    while (run < history.length && history[run] === g) run++
    if (lists.has(g) && eligible(g) && run < (sizes[g] ?? 0)) take(g, (sizes[g] ?? 0) - run)
  }
  while (out.length < limit) {
    let best: string | null = null
    let bestCost = Infinity
    for (const k of Array.from(lists.keys())) {
      if (!eligible(k)) continue
      const cost = (taken.get(k) ?? 0) / (weights[k] as number)
      if (cost < bestCost) {
        bestCost = cost
        best = k
      }
    }
    if (best === null) break
    take(best, sizes[best] || 1)
  }
  return out
}

export function buildUserFeed<T extends FeedVideo>(
  videos: T[],
  skipUrls: Set<string>,
  perPlatform: number = FEED_PER_PLATFORM,
  /**
   * Normalised genre weights from genreWeights(). Left out, the whole list is
   * drawn from the default genre — which is what every link was before genres
   * existed, so an older caller behaves exactly as it did.
   */
  weights: Record<string, number> = genreWeights(null),
  /** Genres of this worker's recent clicks per platform, newest first. */
  history: Record<string, string[]> = {}
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
    // ── ONE ORDERING PER GENRE, THEN MIXED ───────────────────────
    //
    // forPlatform is what does the clustering, and A CLUSTER IS RELATIVE TO THE
    // POOL IT WAS COMPUTED OVER. Clustering the three genres together and mixing
    // afterwards would spread cocodly's handful of links across thirty clusters
    // and call the best of them "cluster 1" — the same mistake that made the
    // client-side clustering of a 100-link slice meaningless.
    //
    // So each genre is ordered within itself, over its whole pool, and only the
    // finished orderings are interleaved.
    const byGenre = new Map<string, T[]>()
    for (const g of GENRES) byGenre.set(g, [])
    for (const v of list) {
      const g = genreOfRow(v)
      const bucket = byGenre.get(g)
      if (bucket) bucket.push(v)
      else byGenre.set(g, [v])
    }
    const ordered = new Map<string, (T & FeedPlacement)[]>()
    for (const [g, rows] of Array.from(byGenre.entries())) {
      if (rows.length === 0) continue
      // THE WHOLE BUDGET, NOT ITS SHARE OF IT. Capping each genre at its own
      // slice was doing the ratio here instead of in the scheduler, and it broke
      // the shortfall rule: a pool that is entirely humanizer would be ordered
      // down to 60 links and then served as 60, because the other two had
      // nothing to make up the difference. The scheduler takes the ratio AND
      // hands unused slots back; this only has to make sure each genre has
      // enough ordered to fill the list on its own if it must.
      ordered.set(g, forPlatform(rows, skip, perPlatform))
    }
    served.push(...interleaveByWeight(ordered, weights, perPlatform, history[key] ?? []))
    remaining[key] = list.reduce((n, v) => (skip(v) ? n : n + 1), 0)
  }
  return { served, remaining }
}
