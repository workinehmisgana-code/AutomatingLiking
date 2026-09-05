// Server-side data for the admin Links page.
//
// This page used to ship the ENTIRE pool to the browser so the client could
// filter, count and paginate it. At 82k links that is ~26 MB of RSC payload on
// every load, to render 100 rows. Everything now happens here and the client
// receives one window plus the pool-wide totals.
//
// The filter and sort semantics are a faithful port of what the component used
// to do in `filtered`/`sorted` — same predicates, same order, same meaning of
// "clicks" (per selected product). Anything else would quietly change what the
// admin sees.

import {
  RANK_CLUSTER_COUNT,
  DATE_CLUSTER_COUNT,
  PRODUCTS,
  retireThreshold,
} from './config'
import { loadVideosJson } from './videos'
import {
  getClickCountsByProductAndUrl,
  getUnrelatedCountsByUrl,
  getBlockedUrls,
  getLinkTitles,
  getEffectivePlatformLimits,
  getLinkStats,
  getProductCommentCountsByUrl,
  getScanCoverage,
  type ScanCoverage,
  type LinkStat,
  getLinkCategories,
} from './db'
import { overlayStats } from './linkStats'
import { parsePostedDate } from './cluster'

/** One row as the client renders it. Carries its own title and click count, so
 *  the browser never needs the 36k-entry title map or the whole click table. */
export interface AdminLinkRow {
  url: string
  platform: string
  search_query: string
  search_rank: number
  like_count: number
  posted_date: string
  scraped_at: string
  unrelated: number
  blocked: boolean
  retireAt: number
  rankCluster: number
  dateCluster: number
  combinedCluster: number
  date_only: boolean
  /** Composite posted-date score (recency + video + hearts) written to the pool
   *  at upload / recluster. null for links scored before it existed. */
  date_score: number | null
  /** Audience the link was categorised into, or '' if not categorised yet. */
  category: string
  /** The score's three parts, 0-1 each (video is 1 or 0). null until rescored. */
  dsRecency: number | null
  dsVideo: number | null
  dsHearts: number | null
  /** Live view count, when the refresh has fetched one. */
  views: number | null
  /** True for a TikTok photo-mode post (image carousel), false for a real video,
   *  null until the counts refresh has read this link. The URL says /video/ for
   *  both, so this is the only way to tell them apart. */
  isPhoto: boolean | null
  /** When the counts were last refreshed (ISO), or null if never. */
  statsAt: string | null
  title: string
  clicks: number
  /** Share of this link's CHANNEL that is still active rather than blocked, as a
   *  percentage. null when the URL carries no channel (YouTube video ids). */
  activePct: number | null
  /** The counts behind that percentage. 94% means nothing without knowing it is
   *  33 of 35 rather than 17 of 18. */
  channelActive: number
  channelBlocked: number
  /**
   * How many of OUR comments are on this video, per product, as found by
   * "Extract comments". `{ purifytext: 2, humlexic: 1 }` means three of ours are
   * on it.
   *
   * null when the link has never been extracted — which is not the same as none
   * found, and the column says so rather than printing a 0 nobody checked.
   */
  ourComments: Record<string, number> | null
  /** Comments the extraction read on this link, null if never extracted. */
  scanRead: number | null
  /** Comments TikTok claims it has — includes replies, which are never read. */
  scanTotal: number | null
  /** Whether that read got everything TikTok admits to. */
  scanComplete: boolean
}

export type ClusterBy = 'rank' | 'date' | 'combined'

export interface LinkQuery {
  /** Keep links whose channel is at least / at most this % active. */
  minRatio?: number | null
  maxRatio?: number | null
  platform?: string
  product?: string
  retiredOnly?: boolean
  unrelatedOnly?: boolean
  blockedOnly?: boolean
  keyword?: string
  /** competitors | ai_detector | generic; '' = any. */
  category?: string
  uploadDate?: string
  titleFilter?: '' | 'has' | 'none'
  /** photo = image carousels only, video = real videos only, unknown = not yet
   *  checked by the counts refresh. '' = any. */
  mediaFilter?: '' | 'photo' | 'video' | 'unknown'
  clusters?: number[]
  clusterBy?: ClusterBy
  minClicks?: number | null
  maxClicks?: number | null
  q?: string
  sortCol?: 'cluster' | 'clicked_by' | null
  sortDir?: 'asc' | 'desc'
  offset?: number
  limit?: number
}

export interface LinkCounts {
  total: number
  byPlatform: Record<string, number>
  retired: number
  unrelated: number
  blocked: number
}

export interface LinkPage {
  rows: AdminLinkRow[]
  /** How many links match the filters (the pager is cut from this). */
  matched: number
  /** Pool-wide totals — deliberately NOT filtered, they describe the whole pool. */
  counts: LinkCounts
  keywords: string[]
  uploadDays: string[]
  products: string[]
  retirePlatforms: string[]
}

/** The channel a link belongs to, from the URL. Null when it carries none. */
function channelOf(url: string): string | null {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
  if (tt) return `tiktok:${tt[1].toLowerCase()}`
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return `youtube:${yt[1].toLowerCase()}`
  const ig = url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)
  if (ig) return `instagram:${ig[1].toLowerCase()}`
  return null
}

const uploadDayOf = (scrapedAt: string): string => {
  const m = (scrapedAt || '').match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

/** Split a sorted list into n contiguous, as-even-as-possible clusters. */
function assignClusters<T>(
  list: T[],
  key: (x: T) => number,
  set: (x: T, cluster: number) => void,
  n: number
): void {
  const s = [...list].sort((a, b) => key(a) - key(b))
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((s.length - start) / (n - i))
    for (let j = start; j < start + size; j++) set(s[j], i + 1)
    start += size
  }
}

/**
 * Build every row, with clusters assigned per platform.
 *
 * Kept as one function so the page and any export share identical numbers; the
 * clustering is relative, so computing it over a subset would give each request
 * a different answer.
 */
export async function buildAdminLinks(product: string): Promise<{
  rows: AdminLinkRow[]
  counts: LinkCounts
  keywords: string[]
  uploadDays: string[]
  products: string[]
  retirePlatforms: string[]
}> {
  const [videos, clicksByProduct, unrelatedCounts, blockedUrls, titles, effective] = await Promise.all([
    loadVideosJson().catch(() => []),
    getClickCountsByProductAndUrl().catch(() => ({}) as Record<string, Record<string, number>>),
    getUnrelatedCountsByUrl().catch(() => ({}) as Record<string, number>),
    getBlockedUrls().catch(() => [] as string[]),
    getLinkTitles().catch(() => ({}) as Record<string, string>),
    getEffectivePlatformLimits().catch(() => ({ retirePlatforms: new Set<string>() })),
  ])
  // What the extraction found on each link, per product. Fetched for the whole
  // pool in one query rather than per row: the table renders thousands of rows
  // and a query each would be thousands of round trips.
  const ourByUrl = await getProductCommentCountsByUrl().catch(
    () => ({}) as Record<string, Record<string, number>>
  )
  // Which links have been LOOKED AT. A link read and found clean writes no
  // product rows at all, so without this it is indistinguishable from one nobody
  // has extracted — and "we checked, it is clean" is the most useful thing the
  // column can say.
  const coverage = await getScanCoverage().catch(
    () => ({}) as Record<string, ScanCoverage>
  )
  // The audience each link was sorted into. Shown in place of the search
  // keyword: which viewers a link reaches decides what comment it should get,
  // and the keyword it was scraped under no longer tells anyone much.
  const categories = await getLinkCategories().catch(() => ({}) as Record<string, string>)
  // Refreshed engagement counts live in their own table; fold them onto the pool
  // rows before anything reads like_count, so the table, the retire threshold and
  // the cluster scores all see the same number.
  const linkStats = await getLinkStats().catch(() => ({}) as Record<string, LinkStat>)
  overlayStats(videos as unknown as { url?: unknown }[], linkStats)
  const blockedSet = new Set(blockedUrls)
  const productKeys = Object.keys(clicksByProduct)
  const products = Array.from(new Set([...PRODUCTS, ...productKeys].filter(Boolean))) as string[]
  const active = product && productKeys.includes(product) ? product : product || products[0] || ''

  // Clicks for a URL, scoped to the selected product — retirement is per product,
  // so "clicked by" always means "by users of this product".
  const clicksOf = (url: string): number => clicksByProduct[active]?.[url] ?? 0

  const rows: AdminLinkRow[] = []
  for (const v of videos) {
    const url = String(v.url ?? '')
    if (!url.startsWith('http')) continue
    const platform = String(v.platform ?? 'unknown')
    const like = Number(v.like_count ?? 0) || 0
    rows.push({
      url,
      platform,
      search_query: String(v.search_query ?? ''),
      search_rank: Number(v.search_rank ?? 0) || 0,
      like_count: like,
      posted_date: String(v.posted_date ?? ''),
      scraped_at: String(v.scraped_at ?? ''),
      unrelated: unrelatedCounts[url] ?? 0,
      // {} = extracted, none of ours. null = never extracted. Different facts.
      ourComments: ourByUrl[url] ?? (coverage[url] ? {} : null),
      scanRead: coverage[url]?.read ?? null,
      scanTotal: coverage[url]?.total ?? null,
      scanComplete: coverage[url]?.complete ?? false,
      blocked: blockedSet.has(url),
      retireAt: retireThreshold(platform, like),
      rankCluster: 0,
      dateCluster: 0,
      combinedCluster: 0,
      date_only: Boolean((v as { date_only?: unknown }).date_only),
      category: categories[url] ?? '',
      date_score: typeof v.date_score === 'number' ? v.date_score : null,
      dsRecency: typeof v.ds_r === 'number' ? v.ds_r : null,
      dsVideo: typeof v.ds_v === 'number' ? v.ds_v : null,
      dsHearts: typeof v.ds_h === 'number' ? v.ds_h : null,
      views: (() => {
        const n = Number((v as { view_count?: unknown }).view_count)
        return Number.isFinite(n) && n > 0 ? n : null
      })(),
      // A /photo/ URL is self-identifying; anything else needs the refreshed flag.
      isPhoto: /\/photo\/\d/.test(url) ? true : (linkStats[url]?.isPhoto ?? null),
      statsAt: linkStats[url]?.fetchedAt ?? null,
      title: titles[url] ?? '',
      clicks: clicksOf(url),
      activePct: null,
      channelActive: 0,
      channelBlocked: 0,
    })
  }

  // Cluster within each platform, for both dimensions.
  const byPlatform = new Map<string, AdminLinkRow[]>()
  for (const r of rows) {
    const list = byPlatform.get(r.platform) ?? []
    list.push(r)
    byPlatform.set(r.platform, list)
  }
  const rankKey = (l: AdminLinkRow) => (l.search_rank > 0 ? l.search_rank : Number.MAX_SAFE_INTEGER)
  // Best-first (assignClusters sorts ascending, so smaller = earlier cluster).
  //
  // All-or-nothing, mirroring clusterAndOrder: once ANY link carries a composite
  // score the whole pool is ranked by score, and anything unscored sorts last.
  // The two scales must never be mixed in one sort — a score is 0–1 while a date
  // is epoch milliseconds, so a single unscored link would outrank the entire
  // pool and land in cluster 1.
  //
  // UNSCORED_LAST is finite on purpose: `Infinity - Infinity` is NaN, and a
  // comparator that returns NaN for a pair leaves the sort order undefined — with
  // ~1k unscored rows (blocked links, which recluster skips) that silently
  // scrambles the ordering rather than just parking them at the end.
  const UNSCORED_LAST = Number.MAX_SAFE_INTEGER
  const anyScored = rows.some((l) => l.date_score !== null)
  const dateKey = (l: AdminLinkRow) =>
    anyScored
      ? l.date_score !== null
        ? -l.date_score
        : UNSCORED_LAST
      : -(parsePostedDate(l.posted_date, l.scraped_at) ?? Number.NEGATIVE_INFINITY)

  byPlatform.forEach((list) => {
    assignClusters(list.filter((l) => !l.date_only), rankKey, (l, c) => (l.rankCluster = c), RANK_CLUSTER_COUNT)
    assignClusters(list, dateKey, (l, c) => (l.dateCluster = c), DATE_CLUSTER_COUNT)
  })
  for (const l of rows) {
    l.combinedCluster = l.date_only ? l.dateCluster : Math.min(l.rankCluster, l.dateCluster)
  }

  // ── Channel active/blocked ratio ─────────────────────────────────────────
  // Per channel: ACTIVE = in the pool and not blocked, BLOCKED = every blocked
  // URL of that channel, including ones no longer in the pool. Ignoring those
  // would flatter exactly the channels that have been cleaned up the most.
  const chanStats = new Map<string, { active: number; blocked: number }>()
  const bump = (ch: string | null, key: 'active' | 'blocked') => {
    if (!ch) return
    const acc = chanStats.get(ch) ?? { active: 0, blocked: 0 }
    acc[key]++
    chanStats.set(ch, acc)
  }
  for (const l of rows) if (!l.blocked) bump(channelOf(l.url), 'active')
  for (const u of blockedUrls) bump(channelOf(u), 'blocked')
  for (const l of rows) {
    const st = chanStats.get(channelOf(l.url) ?? '')
    const tot = st ? st.active + st.blocked : 0
    l.activePct = tot > 0 ? Math.round((st!.active / tot) * 100) : null
    l.channelActive = st?.active ?? 0
    l.channelBlocked = st?.blocked ?? 0
  }

  const retireSet = new Set(Array.from(effective.retirePlatforms))
  const counts: LinkCounts = {
    total: rows.length,
    byPlatform: {},
    retired: 0,
    unrelated: 0,
    blocked: 0,
  }
  for (const l of rows) {
    counts.byPlatform[l.platform] = (counts.byPlatform[l.platform] ?? 0) + 1
    if (retireSet.has(l.platform) && l.clicks >= l.retireAt) counts.retired++
    if (l.unrelated > 0) counts.unrelated++
    if (l.blocked) counts.blocked++
  }

  const keywords = Array.from(new Set(rows.map((l) => l.search_query).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  )
  const uploadDays = Array.from(
    new Set(rows.map((l) => uploadDayOf(l.scraped_at)).filter(Boolean))
  ).sort((a, b) => b.localeCompare(a))

  return {
    rows,
    counts,
    keywords,
    uploadDays,
    products,
    retirePlatforms: Array.from(effective.retirePlatforms),
  }
}

/** Apply the page's filters. A faithful port of the component's `filtered`. */
export function filterAdminLinks(
  rows: AdminLinkRow[],
  qy: LinkQuery,
  retirePlatforms: string[]
): AdminLinkRow[] {
  const retireSet = new Set(retirePlatforms)
  const needle = (qy.q ?? '').toLowerCase().trim()
  const clusterSet = qy.clusters && qy.clusters.length ? new Set(qy.clusters) : null
  const clusterBy: ClusterBy = qy.clusterBy ?? 'rank'
  const clusterOf = (l: AdminLinkRow) =>
    clusterBy === 'rank' ? l.rankCluster : clusterBy === 'date' ? l.dateCluster : l.combinedCluster
  const isRetired = (l: AdminLinkRow) => retireSet.has(l.platform) && l.clicks >= l.retireAt

  return rows.filter((l) => {
    if (qy.platform && l.platform !== qy.platform) return false
    if (qy.retiredOnly && !isRetired(l)) return false
    if (qy.unrelatedOnly && l.unrelated <= 0) return false
    // Blocked links are hidden from the normal list — only shown via "Blocked only".
    if (qy.blockedOnly ? !l.blocked : l.blocked) return false
    if (qy.keyword && l.search_query !== qy.keyword) return false
    if (qy.category && l.category !== qy.category) return false
    if (qy.uploadDate && uploadDayOf(l.scraped_at) !== qy.uploadDate) return false
    if (qy.titleFilter === 'has' && !l.title) return false
    if (qy.titleFilter === 'none' && l.title) return false
    if (qy.mediaFilter === 'photo' && l.isPhoto !== true) return false
    if (qy.mediaFilter === 'video' && l.isPhoto !== false) return false
    if (qy.mediaFilter === 'unknown' && l.isPhoto !== null) return false
    if (clusterSet && !clusterSet.has(clusterOf(l))) return false
    if (qy.minClicks != null && l.clicks < qy.minClicks) return false
    if (qy.maxClicks != null && l.clicks > qy.maxClicks) return false
    // A ratio bound also excludes links with NO channel — "below 50%" can't
    // meaningfully include links whose ratio is unknown.
    if (qy.minRatio != null && (l.activePct == null || l.activePct < qy.minRatio)) return false
    if (qy.maxRatio != null && (l.activePct == null || l.activePct > qy.maxRatio)) return false
    if (needle && !(l.url.toLowerCase().includes(needle) || l.search_query.toLowerCase().includes(needle)))
      return false
    return true
  })
}

/** Apply the page's sort. Unsorted keeps the pool order, as before. */
export function sortAdminLinks(rows: AdminLinkRow[], qy: LinkQuery): AdminLinkRow[] {
  if (!qy.sortCol) return rows
  const clusterBy: ClusterBy = qy.clusterBy ?? 'rank'
  const val = (l: AdminLinkRow) =>
    qy.sortCol === 'cluster'
      ? clusterBy === 'rank'
        ? l.rankCluster
        : clusterBy === 'date'
          ? l.dateCluster
          : l.combinedCluster
      : l.clicks
  const dir = qy.sortDir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => (val(a) - val(b)) * dir)
}
