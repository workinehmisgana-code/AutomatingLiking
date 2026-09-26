// Which channels swallow clicks without ever showing one of our comments.
//
// A click says a worker opened the link. A product comment on the video says the
// click turned into something. Per channel, the ratio between them is the only
// number that says whether sending people to that account is worth anything:
//
//     yield = our product comments found  /  clicks spent
//
// Lowest first. Measured on the live pool, the bottom of that list is stark —
// @studyexpert6 has taken 512 clicks across 50 links and carries zero of our
// comments; nine other channels have taken 60+ clicks each for nothing. Those
// clicks are paid for.
//
// FOUR THINGS MAKE THE RATIO HONEST, and without them it measures our own
// record-keeping instead of the channel:
//
//  1. ONLY LINKS THAT HAVE BEEN SCANNED COUNT. "No comment found" and "nobody
//     looked" are different facts. 8,454 of 16,186 clicked links have never had
//     their comments read, and counting those as zero would put every unscanned
//     channel at the top of the list — a ranking of our scanning backlog.
//
//  2. THE SCAN MUST POSTDATE THE LAST CLICK. A scan taken before the click could
//     not have seen the comment that click was meant to produce. 257 links are
//     in that state; they are excluded and counted as `stale` so a channel with
//     a thin basis can be recognised.
//
//  3. A SCAN THAT READ NOTHING IS NOT AN ABSENCE. A deleted video, a private
//     account or a throttled request all come back as "no comments read", which
//     looks identical to "none of ours is here". 1,539 of the 7,412 otherwise-
//     countable links are in that state. A link counts only when our comment was
//     FOUND (conclusive even on a partial read) or when the read was COMPLETE —
//     the same rule lib/commentPresence applies to a user's own comment, and for
//     the same reason. Applying it halves the channels reading a flat zero, from
//     22 to 10: twelve of them were unreadable scans, not empty videos.
//
//  4. A FLOOR ON CLICKS. One click and no comment is a ratio of zero and means
//     nothing. The caller sets the floor; everything below it is left out rather
//     than shown with a warning nobody reads.
//
// AND ONE THING THE RATIO CANNOT TELL YOU: whose fault it is. A zero can mean the
// channel deletes comments, or that its videos are too busy for ours to survive,
// or that the workers sent there did not post. This ranks the channels; it does
// not convict them.

import { getClickScanByUrl, getProductCommentCounts, getScanCountsByPlatform } from './db'
import { buildAdminLinks, type AdminLinkRow } from './adminLinks'
import { siteOf } from './channelRank'

/** One of a channel's counted links, with enough to judge it. */
export interface YieldLink {
  url: string
  title: string
  clicks: number
  /** Our product comments on it. Zero is the whole point of the barren list. */
  ours: number
  /** Where the link sits in each clustering, or null when it has no place in
   *  that dimension (a merged verify link has no search rank, so no rank
   *  cluster) or is no longer in the pool at all. */
  rankCluster: number | null
  dateCluster: number | null
}

export interface ChannelYieldRow {
  /** "platform:handle" — site and handle, because the same name exists on both. */
  channel: string
  platform: 'tiktok' | 'instagram' | 'youtube'
  handle: string
  profileUrl: string
  /** Links counted: clicked, scanned, and scanned after the last click. */
  links: number
  /** Distinct-user clicks on those links. */
  clicks: number
  /** Our product comments found on them. */
  ours: number
  /** The ratio, as comments per 100 clicks. Lowest is worst. */
  per100: number
  /** Which products were found, so "only one product ever lands here" is visible. */
  byProduct: Record<string, number>
  /** Every clicked link of this channel, whether or not it could be counted. */
  clickedLinks: number
  /** Clicked links whose scan predates the last click — excluded, not zero. */
  stale: number
  /** Clicked links nobody has scanned — excluded, not zero. */
  unscanned: number
  /** Clicked links whose scan could judge nothing — excluded, not zero. */
  unreadable: number
  /**
   * Where this channel's links sit in the two clusterings, averaged.
   *
   * Over ALL of the channel's links still in the pool, not only the counted
   * ones: this describes the channel's standing in the ladders that decide what
   * gets served, and that is a fact about the channel rather than about the
   * sample we happen to have scanned. Cluster 1 is the best, so LOWER IS BETTER
   * — the opposite direction from the yield beside it.
   *
   * null when none of its links has a place in that dimension.
   */
  avgRankCluster: number | null
  avgDateCluster: number | null
  /** How many pool links each average was taken over. */
  rankClusterLinks: number
  dateClusterLinks: number
  /** The counted links carrying at least one of our comments, most-clicked first. */
  withOurs: YieldLink[]
  /** The counted links carrying none, most-clicked first: where the clicks went. */
  withoutOurs: YieldLink[]
}

export interface YieldBasis {
  /** Clicked links in total, and how each was treated. */
  clickedLinks: number
  counted: number
  stale: number
  unscanned: number
  /** Scanned since the last click, but the scan read nothing it could judge. */
  unreadable: number
  /** Clicked+scanned links we could not attribute to any channel, by platform. */
  unattributed: Record<string, number>
  /** Links scanned per platform — the reason the table is one platform wide. */
  scansByPlatform: Record<string, number>
  /** Channels that cleared the click floor, and channels that existed at all. */
  channels: number
  channelsBelowFloor: number
  minClicks: number
}

export interface YieldReport {
  rows: ChannelYieldRow[]
  basis: YieldBasis
}

const PROFILE_URL: Record<string, (h: string) => string> = {
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  youtube: (h) => `https://www.youtube.com/@${h}`,
  instagram: (h) => `https://www.instagram.com/${h}/`,
}

/**
 * Counted links listed per channel, per side.
 *
 * Generous — the biggest channel in the pool has 54 counted links — but finite,
 * because the whole table is one response and an unbounded list per channel is
 * how an admin panel becomes a 30 MB download.
 */
const LINKS_SHOWN = 120

/** Titles are for recognising a video, not for reading it. */
const TITLE_MAX = 140

/**
 * Rank channels by how little of our product comment survives on them, per click.
 *
 * `minClicks` is the floor a channel's counted clicks must reach. There is no
 * sensible default below which a ratio is meaningful, so the caller chooses and
 * the number is reported back with the rows.
 */
export async function channelCommentYield(minClicks: number): Promise<YieldReport> {
  const [links, byProductUrl, scansByPlatform, pool] = await Promise.all([
    getClickScanByUrl().catch(() => []),
    getProductCommentCounts().catch(() => ({}) as Record<string, Record<string, number>>),
    getScanCountsByPlatform().catch(() => ({}) as Record<string, number>),
    // The SAME build the Links table renders, so the cluster numbers shown here
    // are the cluster numbers shown there. Computing them a second way would
    // give two answers to one question, and the one in this panel would be the
    // one nobody could reproduce.
    buildAdminLinks('').catch(() => ({ rows: [] as AdminLinkRow[] })),
  ])

  // An Instagram post URL is /p/<code>/ and names nobody, so the handle comes
  // from the author the scrape stored beside it — which buildAdminLinks has
  // already resolved into `channel`. Without it every Instagram link is
  // unattributable, the failure that hid @betweenstudybreaks from the channel
  // list entirely.
  const poolRow = new Map<string, AdminLinkRow>()
  for (const r of pool.rows) if (r.url) poolRow.set(r.url, r)

  interface Acc {
    handle: string
    platform: 'tiktok' | 'instagram' | 'youtube'
    links: number
    clicks: number
    ours: number
    byProduct: Record<string, number>
    clickedLinks: number
    stale: number
    unscanned: number
    unreadable: number
    withOurs: YieldLink[]
    withoutOurs: YieldLink[]
  }
  const acc = new Map<string, Acc>()
  const basis: YieldBasis = {
    clickedLinks: links.length,
    counted: 0,
    stale: 0,
    unscanned: 0,
    unreadable: 0,
    unattributed: {},
    scansByPlatform,
    channels: 0,
    channelsBelowFloor: 0,
    minClicks,
  }

  const blank = (handle: string, platform: 'tiktok' | 'instagram' | 'youtube'): Acc => ({
    handle,
    platform,
    links: 0,
    clicks: 0,
    ours: 0,
    byProduct: {},
    clickedLinks: 0,
    stale: 0,
    unscanned: 0,
    unreadable: 0,
    withOurs: [],
    withoutOurs: [],
  })

  /** The handle a URL belongs to: the pool's answer, else the URL's own. */
  const handleFor = (url: string): string | null => {
    const r = poolRow.get(url)
    if (r?.channel) return r.channel
    // Links a worker opened that are no longer in the pool — blocked, or removed
    // by a recluster. The URL is all there is left of them.
    const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
    if (tt) return tt[1].toLowerCase()
    const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
    if (yt) return yt[1].toLowerCase()
    const ig = url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)
    if (ig) return ig[1].toLowerCase()
    return null
  }

  for (const l of links) {
    const scanned = l.scannedAt !== null && l.ourCount !== null
    // Both are epoch milliseconds off the same clock — see ClickScanRow.
    const fresh = scanned && (l.scannedAt as number) >= l.lastClick
    // A HIT is conclusive even on a partial read — we saw the comment. A MISS
    // counts only when the whole list was readable. Straight from
    // lib/commentPresence's `judgeable`, so the two places that decide whether a
    // missing comment means anything decide it the same way.
    const judgeable =
      fresh && ((l.ourCount ?? 0) > 0 || ((l.readCount ?? 0) > 0 && l.complete))
    if (!scanned) basis.unscanned++
    else if (!fresh) basis.stale++
    else if (!judgeable) basis.unreadable++
    else basis.counted++

    const handle = handleFor(l.url)
    if (!handle) {
      // Only counted for links that could otherwise have been used: an
      // unattributable link nobody scanned is not a gap in this table.
      if (fresh) {
        const p = siteOf(l.url)
        basis.unattributed[p] = (basis.unattributed[p] ?? 0) + 1
      }
      continue
    }
    const platform = siteOf(l.url)
    const key = `${platform}:${handle}`
    const a = acc.get(key) ?? blank(handle, platform)
    a.clickedLinks++
    if (!scanned) a.unscanned++
    else if (!fresh) a.stale++
    else if (!judgeable) a.unreadable++
    else {
      const ours = l.ourCount ?? 0
      a.links++
      a.clicks += l.clicks
      a.ours += ours
      for (const [p, n] of Object.entries(byProductUrl[l.url] ?? {})) {
        a.byProduct[p] = (a.byProduct[p] ?? 0) + n
      }
      const r = poolRow.get(l.url)
      const entry: YieldLink = {
        url: l.url,
        title: (r?.title ?? '').slice(0, TITLE_MAX),
        clicks: l.clicks,
        ours,
        // A merged verify link has no search rank and is left out of the rank
        // clustering entirely, which buildAdminLinks leaves as 0. Zero is not a
        // cluster, so it reads as "no place in this dimension" rather than being
        // averaged in as the best possible one.
        rankCluster: r && r.rankCluster > 0 ? r.rankCluster : null,
        dateCluster: r && r.dateCluster > 0 ? r.dateCluster : null,
      }
      ;(ours > 0 ? a.withOurs : a.withoutOurs).push(entry)
    }
    acc.set(key, a)
  }

  // ── Where the channel's links sit in the two ladders ───────────────────────
  // Over every pool link of the channel, not only the counted ones: this is the
  // channel's standing in the orderings that decide what gets served, and the
  // scanned sample is not the right denominator for that.
  interface ClusterAcc { rank: number; rankN: number; date: number; dateN: number }
  const clusters = new Map<string, ClusterAcc>()
  for (const r of pool.rows) {
    if (!r.channel) continue
    const key = `${siteOf(r.url)}:${r.channel}`
    if (!acc.has(key)) continue
    const c = clusters.get(key) ?? { rank: 0, rankN: 0, date: 0, dateN: 0 }
    if (r.rankCluster > 0) { c.rank += r.rankCluster; c.rankN++ }
    if (r.dateCluster > 0) { c.date += r.dateCluster; c.dateN++ }
    clusters.set(key, c)
  }

  const rows: ChannelYieldRow[] = []
  acc.forEach((a, channel) => {
    if (a.links === 0) return
    basis.channels++
    if (a.clicks < minClicks) {
      basis.channelsBelowFloor++
      return
    }
    const c = clusters.get(channel) ?? { rank: 0, rankN: 0, date: 0, dateN: 0 }
    const mostClickedFirst = (x: YieldLink, y: YieldLink) => y.clicks - x.clicks || x.url.localeCompare(y.url)
    rows.push({
      channel,
      platform: a.platform,
      handle: a.handle,
      profileUrl: PROFILE_URL[a.platform]?.(a.handle) ?? '',
      links: a.links,
      clicks: a.clicks,
      ours: a.ours,
      // Rounded to one place: the ordering uses the exact value below, so this
      // is only what gets printed.
      per100: Math.round((1000 * a.ours) / a.clicks) / 10,
      byProduct: a.byProduct,
      clickedLinks: a.clickedLinks,
      stale: a.stale,
      unscanned: a.unscanned,
      unreadable: a.unreadable,
      avgRankCluster: c.rankN > 0 ? Math.round((10 * c.rank) / c.rankN) / 10 : null,
      avgDateCluster: c.dateN > 0 ? Math.round((10 * c.date) / c.dateN) / 10 : null,
      rankClusterLinks: c.rankN,
      dateClusterLinks: c.dateN,
      withOurs: a.withOurs.sort(mostClickedFirst).slice(0, LINKS_SHOWN),
      withoutOurs: a.withoutOurs.sort(mostClickedFirst).slice(0, LINKS_SHOWN),
    })
  })

  // Worst first, and among equally bad channels the one that has taken the most
  // clicks first — two channels at zero are not equally worth acting on when one
  // has spent 512 clicks and the other 26. Handle breaks the remaining ties so
  // the order does not shuffle between requests. The page can re-sort by any
  // column; this is what it opens on.
  rows.sort(
    (a, b) =>
      a.ours / a.clicks - b.ours / b.clicks ||
      b.clicks - a.clicks ||
      a.channel.localeCompare(b.channel)
  )
  return { rows, basis }
}
