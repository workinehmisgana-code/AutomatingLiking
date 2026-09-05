// Priority clustering — the same scheme the scraper-automation and web dashboard
// use: split links into clusters by search rank AND by posted date, then
// interleave them (rank-cluster 1, date-cluster 1, rank-cluster 2, …) so the
// order alternates between "best search rank" and "most recent".

import { RANK_CLUSTER_COUNT, DATE_CLUSTER_COUNT } from './config'

export interface Clusterable {
  url: string
  search_rank?: number
  posted_date?: string
  scraped_at?: string
  date_only?: boolean // no search rank; clusters by posted date only
  /** Composite posted-date score (recency + video + hearts), set at
   *  upload time by lib/dateScore.ts. Falls back to plain recency when absent. */
  date_score?: number
}

/**
 * Normalise a scraped posted_date into epoch-ms, or null. Mirrors the web
 * dashboard's parsePostedDate (relative words/abbreviations + absolute dates).
 */
export function parsePostedDate(raw: string | undefined, scrapedAt: string | undefined): number | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  const base = Date.parse(scrapedAt || '') || Date.now()

  if (s === 'just now' || s === 'today') return base
  if (s === 'yesterday') return base - 86_400_000

  const unitMs: Record<string, number> = {
    second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000,
    week: 604_800_000, month: 2_629_800_000, year: 31_557_600_000,
    s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, mo: 2_629_800_000, y: 31_557_600_000,
  }
  const rel = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/)
  if (rel) return base - parseInt(rel[1], 10) * (unitMs[rel[2]] ?? 0)
  const relAbbr = s.match(/^(\d+)\s*(mo|s|m|h|d|w|y)\s*ago$/)
  if (relAbbr) return base - parseInt(relAbbr[1], 10) * (unitMs[relAbbr[2]] ?? 0)

  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3])
  m = s.match(/^(\d{1,2})[-/](\d{1,2})$/)
  if (m) {
    const y = new Date(base).getUTCFullYear()
    let t = Date.UTC(y, +m[1] - 1, +m[2])
    if (t > base + 86_400_000) t = Date.UTC(y - 1, +m[1] - 1, +m[2])
    return t
  }
  const parsed = Date.parse(raw)
  return isNaN(parsed) ? null : parsed
}

// Split into n contiguous, as-even-as-possible clusters.
function chunk<T>(sorted: T[], n: number): T[][] {
  const out: T[][] = []
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((sorted.length - start) / (n - i))
    out.push(sorted.slice(start, start + size))
    start += size
  }
  return out
}

/**
 * Order links by clusters. `dimension` selects which clustering drives the order:
 *   • 'rank'     — search-rank clusters only (cluster 1 → N)
 *   • 'date'     — posted-date clusters only (newest cluster → oldest)
 *   • 'combined' — interleave rank & date clusters (default)
 * Links WITHIN each cluster keep the clustering score's own order: search rank
 * ascending for a rank cluster, date score descending for a date cluster. That
 * score is the only thing deciding where a link sits.
 */
export function clusterAndOrder<T extends Clusterable>(
  items: T[],
  nClusters?: number, // optional override for BOTH dimensions; omit to use per-dimension config
  dimension: 'rank' | 'date' | 'combined' = 'combined'
): T[] {
  if (items.length <= 1) return items.slice()

  // date_only links (merged from the verify list) have NO search rank — they take
  // part ONLY in the posted-date clusters, never the search-rank clusters.
  const isDateOnly = (e: T) => !!(e as { date_only?: boolean }).date_only
  const rankItems = items.filter((e) => !isDateOnly(e))

  // Search rank → 30 clusters, posted date → 50 (both configurable). An explicit
  // nClusters overrides both. Capped by how many items each dimension actually has.
  const rankN = Math.max(1, Math.min(nClusters ?? RANK_CLUSTER_COUNT, rankItems.length || 1))
  const dateN = Math.max(1, Math.min(nClusters ?? DATE_CLUSTER_COUNT, items.length))

  const rankOf = (e: T) => (e.search_rank && e.search_rank > 0 ? e.search_rank : Number.MAX_SAFE_INTEGER)
  const byRank = [...rankItems].sort((a, b) => rankOf(a) - rankOf(b))
  const rankClusters = chunk(byRank, rankN)

  // The "date" dimension is the composite score when it has been computed (see
  // lib/dateScore.ts), plain recency otherwise — so a pool uploaded before
  // scoring existed still clusters sensibly instead of collapsing to one bucket.
  const scored = items.some((e) => typeof e.date_score === 'number')
  const dateKey = (e: T) =>
    scored
      ? typeof e.date_score === 'number'
        ? e.date_score
        : Number.NEGATIVE_INFINITY
      : parsePostedDate(e.posted_date, e.scraped_at) ?? Number.NEGATIVE_INFINITY
  const byDate = [...items].sort((a, b) => dateKey(b) - dateKey(a))
  const dateClusters = chunk(byDate, dateN)

  // Ordering WITHIN a cluster: the clustering score, and nothing else.
  //
  // That order is already there — byRank is sorted by search rank ascending and
  // byDate by date score descending, and chunk() preserves it — so a cluster is
  // emitted exactly as it was built.
  //
  // Three re-orderings have been tried on top of this and all three are gone:
  //   * distinct clicks, which counted who had OPENED a link rather than what
  //     was on it, and kept rising on links whose comments never appeared;
  //   * a shuffle of the never-extracted links, which put the same score's links
  //     in a different order for every user for no gain;
  //   * fewest of our comments first, which reordered by extraction results and
  //     so made the served order depend on how recently a scan had run.
  // A link's place in the queue is now decided by one number, the same number
  // that put it in its cluster.
  const seen = new Set<string>()
  const out: T[] = []
  const emit = (cluster: T[]) => {
    for (const e of cluster) {
      if (!seen.has(e.url)) {
        seen.add(e.url)
        out.push(e)
      }
    }
  }

  // Finish each cluster fully before the next (cluster 1 → N). For 'combined' the
  // i-th rank cluster AND i-th date cluster are both drained before level i+1.
  if (dimension === 'rank') {
    for (let i = 0; i < rankN; i++) emit(rankClusters[i])
    emit(rankItems) // safety net — NOT `items`, so date_only stays out of rank
  } else if (dimension === 'date') {
    for (let i = 0; i < dateN; i++) emit(dateClusters[i])
    emit(items) // safety net
  } else {
    // Interleave: the counts can differ (rank 30, date 50), so walk to the larger.
    const levels = Math.max(rankN, dateN)
    for (let i = 0; i < levels; i++) {
      if (i < rankN) emit(rankClusters[i]) // i-th search-rank cluster
      if (i < dateN) emit(dateClusters[i]) // then i-th posted-date cluster (leftovers)
    }
    emit(items) // safety net (date_only reach here only via date clusters above)
  }
  return out
}
