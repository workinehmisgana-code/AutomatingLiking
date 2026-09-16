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
  DEFAULT_SEARCH_FIELDS,
  isSearchField,
  type SearchField,
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
  getChannelBios,
} from './db'
import { overlayStats } from './linkStats'
import { parsePostedDate } from './cluster'
import { isPhotoLink } from './dateScore'

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
  /** 1-based place WITHIN the link's own cluster, in the order the feed serves
   *  it — best search rank first, or highest date score first. Set by the same
   *  sorted pass that assigns the cluster, so the two can never disagree. */
  rankPos: number
  datePos: number
  date_only: boolean
  /** Composite posted-date score (recency + video + hearts) written to the pool
   *  at upload / recluster. null for links scored before it existed. */
  date_score: number | null
  /** Audience the link was categorised into, or '' if not categorised yet. */
  category: string
  /**
   * The account that posted it, bare and lowercased, or '' when unknown.
   *
   * From the URL where the URL carries it (TikTok, YouTube), and from the
   * stored author otherwise. INSTAGRAM IS THE REASON THE FALLBACK EXISTS: a
   * post is /p/<code>/ and names nobody, so without the author an Instagram
   * link has no channel at all and could never be searched by one.
   *
   * Deliberately NOT the key channelOf() builds for the Active% column. That
   * one is URL-only on purpose, because the blocked list is a list of URLs with
   * no author beside them — grouping active links by author while blocked ones
   * group by nothing would count every Instagram channel as 100% active.
   */
  channel: string
  /** The channel's profile bio, or '' when we have never fetched one. */
  bio: string
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
  /**
   * Whether the video carries any of OUR product comments.
   *
   *   none      extracted, and none of ours was found. Proof.
   *   some      extracted, and at least one was found.
   *   unscanned never extracted — no evidence either way.
   *
   * 'none' and 'unscanned' are deliberately separate. Merging them would report
   * 125,070 links nobody has ever looked at as "proven to have none of ours",
   * which is the difference between a gap you can act on and one you invented.
   */
  oursFilter?: '' | 'none' | 'some' | 'unscanned'
  /**
   * Only links carrying THIS product's comment.
   *
   * Separate from oursFilter, which asks whether ANY of ours is there. "which
   * of our products is already on this video" is a different question, and the
   * answer decides which product to serve next — a video already led by one is
   * meant to stay with it (see pickFairProductForUrl).
   */
  oursProduct?: string
  /** photo = image carousels only, video = real videos only, unknown = not yet
   *  checked by the counts refresh. '' = any. */
  mediaFilter?: '' | 'photo' | 'video' | 'unknown'
  clusters?: number[]
  clusterBy?: ClusterBy
  /**
   * How many of OUR comments are on the video, across every product.
   *
   * A link nobody has extracted has NO count — not a count of zero — so it can
   * never satisfy a bound. "at least 1 of ours" must not return 135k links
   * whose comment sections nobody has read.
   */
  minOurs?: number | null
  maxOurs?: number | null
  minClicks?: number | null
  maxClicks?: number | null
  q?: string
  /** Which fields `q` looks in. Null/empty = DEFAULT_SEARCH_FIELDS. */
  searchIn?: SearchField[] | null
  sortCol?: 'cluster' | 'clicked_by' | 'unrelated' | 'ours' | 'pos' | 'rank' | null
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
  /**
   * Active links with NO search rank (merged from the verify list). They are
   * hidden while "Cluster by: Search rank" is on, so the page can say how many
   * the tab is holding back. Blocked links are left out: they are already
   * hidden for a different reason.
   */
  dateOnly: number
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

/**
 * The posting account, for SEARCH: bare handle, lowercased, '' when unknown.
 *
 * The URL first, because it cannot be mislabelled, then the stored author.
 * TikTok and YouTube put the handle in the URL; Instagram does not, so for
 * Instagram the author is the only source there is — and 11,443 of its 15,594
 * links have one.
 *
 * Returns a BARE handle, not the "platform:handle" key channelOf() returns:
 * somebody searching "mrbeast" should find them on every platform at once.
 */
function searchChannelOf(url: string, author: unknown): string {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
  if (tt) return tt[1].toLowerCase()
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return yt[1].toLowerCase()
  const ig = url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)
  if (ig) return ig[1].toLowerCase()
  return String(author ?? '').trim().replace(/^@/, '').toLowerCase()
}

const uploadDayOf = (scrapedAt: string): string => {
  const m = (scrapedAt || '').match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

/**
 * Split a sorted list into n contiguous, as-even-as-possible clusters, and
 * record each link's place inside its own cluster.
 *
 * The position comes from THIS pass rather than being computed later, because
 * this is the sort that decides it: the list is already in the feed's serving
 * order, so the j-th entry of a cluster is the j-th link that cluster serves.
 * Deriving it separately would be a second sort that could drift from this one.
 */
function assignClusters<T>(
  list: T[],
  key: (x: T) => number,
  set: (x: T, cluster: number, posInCluster: number) => void,
  nWanted: number
): void {
  const s = [...list].sort((a, b) => key(a) - key(b))
  // CAPPED AT THE NUMBER OF LINKS, which matters only for a thin platform — and
  // is exactly where it used to go wrong.
  //
  // The chunk size is floor(remaining / clusters left), so with fewer links than
  // clusters every early cluster takes ZERO and the links pile into the last
  // ones: a platform with 20 links and 30 clusters had its best link land in
  // cluster 11, and a platform with 1 link put it in cluster 30. Users work
  // clusters 1-3, so a small platform's best links were never reached at all.
  //
  // Capping gives that platform as many clusters as it has links, starting at 1.
  // lib/cluster.ts (the app's own feed) has always done this; the admin page and
  // the pipeline read from here, so the two disagreed about the same links.
  const n = Math.max(1, Math.min(nWanted, s.length))
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((s.length - start) / (n - i))
    for (let j = start; j < start + size; j++) set(s[j], i + 1, j - start + 1)
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
  // Channel bios, by bare handle. Only ~4k channels have one, so most links
  // carry '' here and simply never match a bio search.
  const bios = await getChannelBios().catch(() => ({}) as Record<string, string>)
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
    const channel = searchChannelOf(url, (v as { author?: unknown }).author)
    rows.push({
      url,
      platform,
      channel,
      bio: channel ? bios[channel] ?? '' : '',
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
      rankPos: 0,
      datePos: 0,
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
      // One shared rule with the scoring (lib/dateScore) — these used to differ
      // on whether the URL or the stored flag wins, so a link could read as a
      // photo in this table and a video in its score.
      isPhoto: isPhotoLink(url, linkStats[url]?.isPhoto ?? null),
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
    assignClusters(
      list.filter((l) => !l.date_only),
      rankKey,
      (l, c, pos) => { l.rankCluster = c; l.rankPos = pos },
      RANK_CLUSTER_COUNT
    )
    assignClusters(list, dateKey, (l, c, pos) => { l.dateCluster = c; l.datePos = pos }, DATE_CLUSTER_COUNT)
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
    dateOnly: 0,
  }
  for (const l of rows) {
    counts.byPlatform[l.platform] = (counts.byPlatform[l.platform] ?? 0) + 1
    if (retireSet.has(l.platform) && l.clicks >= l.retireAt) counts.retired++
    if (l.unrelated > 0) counts.unrelated++
    if (l.blocked) counts.blocked++
    else if (l.date_only) counts.dateOnly++
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

/**
 * Read a LinkQuery out of a request's query string.
 *
 * ONE parser, shared by every endpoint that answers a question about "the links
 * currently filtered on the page". There used to be two, and they disagreed:
 * the scan endpoint read the title filter from `titleFilter` while the page
 * sends `title`, ignored eight filters outright, and — the one that bit — kept
 * NON-POSITIVE cluster numbers. With no cluster ticked the page omits the
 * parameter, which parsed as `[0]`: a filter for "cluster zero", a cluster no
 * link belongs to. A press then covered a set nobody had asked for.
 *
 * Any endpoint that scopes work to the page's filters must call this rather than
 * roll its own, or the number in the confirm dialog stops describing the work.
 */
export function parseLinkQuery(sp: URLSearchParams): LinkQuery {
  const num = (v: string | null) => {
    if (v == null || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const tf = sp.get('title') ?? sp.get('titleFilter')
  const mf = sp.get('media')
  const ours = sp.get('ours')
  const sortCol = sp.get('sortCol')
  return {
    platform: sp.get('platform') ?? '',
    product: sp.get('product') ?? '',
    retiredOnly: sp.get('retired') === '1',
    unrelatedOnly: sp.get('unrelated') === '1',
    blockedOnly: sp.get('blocked') === '1',
    keyword: sp.get('keyword') ?? '',
    oursFilter: (['none', 'some', 'unscanned'] as const).includes(
      ours as 'none' | 'some' | 'unscanned'
    )
      ? (ours as 'none' | 'some' | 'unscanned')
      : '',
    // A specific product's comment on the video, rather than "any of ours".
    oursProduct: String(sp.get('oursProduct') ?? '').trim(),
    category: sp.get('category') ?? '',
    uploadDate: sp.get('uploadDate') ?? sp.get('uploadDay') ?? '',
    titleFilter: tf === 'has' || tf === 'none' ? tf : '',
    mediaFilter: mf === 'photo' || mf === 'video' || mf === 'unknown' ? mf : '',
    // `n > 0` is load-bearing: a missing parameter splits to [''], which is 0,
    // and a zero here means "only links in cluster 0" rather than "no cluster
    // filter". Every link has a cluster of 1 or more, so that matches nothing.
    clusters: (sp.get('clusters') ?? '')
      .split(',')
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0),
    clusterBy: ((sp.get('clusterBy') as ClusterBy) || 'rank') as ClusterBy,
    minOurs: num(sp.get('minOurs')),
    maxOurs: num(sp.get('maxOurs')),
    minClicks: num(sp.get('minClicks')),
    maxClicks: num(sp.get('maxClicks')),
    minRatio: num(sp.get('minRatio')),
    maxRatio: num(sp.get('maxRatio')),
    q: sp.get('q') ?? '',
    // Absent means "the default fields", not "no fields" — an omitted parameter
    // must never turn the search box into something that matches nothing.
    searchIn: (sp.get('searchIn') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(isSearchField),
    sortCol:
      sortCol === 'cluster' ||
      sortCol === 'clicked_by' ||
      sortCol === 'unrelated' ||
      sortCol === 'ours' ||
      sortCol === 'pos' ||
      sortCol === 'rank'
        ? sortCol
        : null,
    sortDir: sp.get('sortDir') === 'asc' ? 'asc' : 'desc',
  }
}

/** The text one search field offers, already lowercased. */
function searchText(l: AdminLinkRow, field: SearchField): string {
  switch (field) {
    case 'url':
      return l.url.toLowerCase()
    case 'keyword':
      return l.search_query.toLowerCase()
    case 'title':
      return l.title.toLowerCase()
    case 'channel':
      return l.channel
    case 'bio':
      return l.bio.toLowerCase()
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
  // Empty or unrecognised picks fall back to the default rather than matching
  // nothing: a search box that silently returns zero results is worse than one
  // that searches the obvious fields.
  const picked = (qy.searchIn ?? []).filter(isSearchField)
  const fields: readonly SearchField[] = picked.length ? picked : DEFAULT_SEARCH_FIELDS
  const clusterSet = qy.clusters && qy.clusters.length ? new Set(qy.clusters) : null
  const clusterBy: ClusterBy = qy.clusterBy ?? 'rank'
  const clusterOf = (l: AdminLinkRow) =>
    clusterBy === 'rank' ? l.rankCluster : clusterBy === 'date' ? l.dateCluster : l.combinedCluster
  const isRetired = (l: AdminLinkRow) => retireSet.has(l.platform) && l.clicks >= l.retireAt

  return rows.filter((l) => {
    // "Cluster by: Search rank" means exactly that: only links that HAVE a
    // search rank. Links merged from the verify list carry none, so
    // assignClusters leaves them out of the rank dimension entirely (rankCluster
    // 0, no position) and they used to fill the list with rows of dashes. They
    // are untouched under Posted date and Combined, which is where they belong.
    if (clusterBy === 'rank' && l.date_only) return false
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
    if (qy.oursFilter) {
      // null = never extracted; {} = extracted and clean; non-empty = carries ours.
      const ours = l.ourComments
      const has = !!ours && Object.keys(ours).length > 0
      if (qy.oursFilter === 'unscanned' && ours !== null) return false
      if (qy.oursFilter === 'none' && (ours === null || has)) return false
      if (qy.oursFilter === 'some' && !has) return false
    }
    // A named product, rather than "any of ours". A link nobody has extracted
    // cannot match: we do not know what is on it.
    if (qy.oursProduct && !((l.ourComments?.[qy.oursProduct] ?? 0) > 0)) return false
    if (qy.mediaFilter === 'photo' && l.isPhoto !== true) return false
    if (qy.mediaFilter === 'video' && l.isPhoto !== false) return false
    if (qy.mediaFilter === 'unknown' && l.isPhoto !== null) return false
    if (clusterSet && !clusterSet.has(clusterOf(l))) return false
    if (qy.minOurs != null || qy.maxOurs != null) {
      // Never extracted is excluded from BOTH bounds — see minOurs.
      if (l.ourComments === null) return false
      const n = Object.values(l.ourComments).reduce((a, x) => a + x, 0)
      if (qy.minOurs != null && n < qy.minOurs) return false
      if (qy.maxOurs != null && n > qy.maxOurs) return false
    }
    if (qy.minClicks != null && l.clicks < qy.minClicks) return false
    if (qy.maxClicks != null && l.clicks > qy.maxClicks) return false
    // A ratio bound also excludes links with NO channel — "below 50%" can't
    // meaningfully include links whose ratio is unknown.
    if (qy.minRatio != null && (l.activePct == null || l.activePct < qy.minRatio)) return false
    if (qy.maxRatio != null && (l.activePct == null || l.activePct > qy.maxRatio)) return false
    // The free-text search, over whichever fields the admin picked.
    //
    // A field the link has nothing for simply never matches: those are '', and
    // ''.includes(needle) is false for any real needle. So an untitled link
    // cannot be found by title, and a link whose channel we never learned
    // cannot be found by channel — which is the honest answer, not a bug.
    if (needle && !fields.some((f) => searchText(l, f).includes(needle))) return false
    return true
  })
}

/** Where a link with no search rank sorts. See the 'rank' branch below. */
const UNRANKED_LAST = Number.MAX_SAFE_INTEGER

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
      : qy.sortCol === 'pos'
        // Where the link sits INSIDE its cluster. Read from the same dimension
        // that chose the cluster: under 'combined' that is whichever put the
        // link earliest, so taking the rank position beside a cluster the date
        // dimension chose would be two different numbers pretending to be one.
        ? clusterBy === 'rank'
          ? l.rankPos
          : clusterBy === 'date'
            ? l.datePos
            : l.date_only
              ? l.datePos
              : l.dateCluster < l.rankCluster
                ? l.datePos
                : l.rankPos
      : qy.sortCol === 'rank'
        // The link's placing in the search results for its keyword. A PLACING,
        // not a quantity: #1 is the best, so ascending is the useful direction
        // and the header opens on it.
        //
        // A link with no rank sorts as UNRANKED_LAST rather than 0, which would
        // otherwise make "no rank at all" the best rank in the table. Finite on
        // purpose: Infinity - Infinity is NaN, and a comparator that returns NaN
        // for a pair leaves the whole order undefined.
        ? l.search_rank > 0
          ? l.search_rank
          : UNRANKED_LAST
      : qy.sortCol === 'ours'
        // How many of OUR comments the extraction found, across every product.
        // A link nobody has extracted sorts as -1, not 0: "never looked" and
        // "looked and found none" are different, and descending order should
        // not open with thousands of unknowns.
        ? l.ourComments === null
          ? -1
          : Object.values(l.ourComments).reduce((a, n) => a + n, 0)
      : qy.sortCol === 'unrelated'
        // How many users reported the link as nothing to do with humanizers.
        // Sorted DESC by default like the others, which puts the most-reported
        // links first — the ones actually worth a decision.
        ? l.unrelated
        : l.clicks
  const dir = qy.sortDir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => (val(a) - val(b)) * dir)
}
