// Ranking the channels we extract new videos from.
//
// Four signals, 25% each:
//
//   links      how many of the channel's videos are already in the pool
//   hearts     the channel's TYPICAL (median) like count
//   frequency  how often it posts (videos per day across its observed span)
//   active     share of its links still active rather than blocked
//
// Every signal is a PERCENTILE across channels, not a raw value, for the same
// reason the posted-date score uses percentiles: like counts span 0 to millions
// while a ratio is 0–1, so a raw blend would be entirely decided by whichever
// number happens to be largest. Percentiles put all four on one 0–1 footing and
// make "25% each" mean what it says.
//
// This needs no network at all — everything comes from videos.json, blocked_link
// and link_stat — so the button answers immediately.

import { loadVideosJson } from './videos'
import { getBlockedUrls, getLinkStats, type LinkStat } from './db'
import { overlayStats } from './linkStats'
import { parsePostedDate } from './cluster'

export interface ChannelRow {
  handle: string
  /** Which site it is on — a handle alone does not say. */
  platform: 'tiktok' | 'instagram' | 'youtube'
  /** Links of this channel still in the pool (blocked ones are removed from it). */
  links: number
  /** Pool links not on the blocked list. */
  active: number
  /** EVERY blocked link of this channel, including ones long gone from the pool. */
  blocked: number
  activePct: number | null
  /** The channel's TYPICAL like count — a median, so one viral post does not
   *  speak for the channel. Named avgHearts for the callers that read it. */
  avgHearts: number | null
  /** Videos per day across the channel's observed posting span. */
  perDay: number | null
  /** Days since its most recent post we know of. */
  lastPostDays: number | null
  score: number
}

/**
 * The channel handle in a URL, lowercased, or null.
 *
 * TikTok and YouTube put the handle in the video URL. INSTAGRAM DOES NOT — a
 * post is /p/<code>/ or /reel/<code>/ and names nobody — which is why every
 * caller must pass the row's stored author as a fallback. Without it Instagram
 * links group under no channel at all, and the whole channel table comes back
 * empty however many links are in the pool.
 */
export function handleOf(url: string): string | null {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)\/(?:video|photo)\/\d+/i)
  if (tt) return tt[1].toLowerCase()
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return yt[1].toLowerCase()
  return null
}

/** The handle for a pool row: from its URL, else the author it was stored with. */
export function channelOfRow(url: string, author: unknown): string | null {
  return handleOf(url) ?? (String(author ?? '').trim().replace(/^@/, '').toLowerCase() || null)
}

/** Which site a channel is on, so its page can be opened. */
export function siteOf(url: string): 'tiktok' | 'instagram' | 'youtube' {
  const u = url.toLowerCase()
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  return 'tiktok'
}

/**
 * Percentile rank over ROWS, ties sharing their run's midpoint.
 *
 * Same shape as the one in lib/dateScore.ts, and for the same reason: ranking
 * distinct values instead would let a handful of huge channels dominate the
 * scale and squash everyone else into the bottom of it.
 */
/** The middle value — what a channel typically gets, immune to one viral post. */
function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function percentiles(values: number[]): Map<number, number> {
  const out = new Map<number, number>()
  const n = values.length
  if (n === 0) return out
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted[0] === sorted[n - 1]) {
    out.set(sorted[0], 1)
    return out
  }
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && sorted[j + 1] === sorted[i]) j++
    out.set(sorted[i], (i + j) / 2 / (n - 1))
    i = j + 1
  }
  return out
}

interface Acc {
  handle: string
  site: 'tiktok' | 'instagram' | 'youtube'
  links: number
  active: number
  hearts: number[]
  times: number[]
}

/**
 * The key a channel is accumulated under: SITE AND HANDLE, not handle alone.
 *
 * The same name is routinely taken on two sites by the same person — measured
 * on the live pool, 98 of our handles exist on more than one. Keyed by handle
 * alone they were folded into ONE row whose platform was whichever URL happened
 * to be seen last, so @betweenstudybreaks (58 Instagram links + 205 TikTok)
 * appeared once, as TikTok, and its Instagram side could not be found at all.
 *
 * Worse than a missing row: every number on the merged one — links, median
 * hearts, posting rate, active share — was computed across two platforms at
 * once, so the score that ordered it described neither.
 *
 * scrape_channels.py has always namespaced its accounts this way
 * (account_key); this brings the ranking in line with it.
 */
const channelKey = (site: string, handle: string) => `${site}:${handle}`

/**
 * Every channel in the pool, best first.
 *
 * Channels whose links have ALL been blocked never appear: they are absent from
 * the pool, and there is no reason to spend a request re-checking a channel we
 * have rejected outright.
 */
/**
 * Links we hold that cannot be attributed to ANY channel, by platform.
 *
 * Not a failure of the ranking — a fact about the links. A YouTube Shorts URL
 * is /shorts/<id> and names nobody, and an Instagram post is /p/<code>/ which
 * names nobody either, so an Instagram link is only attributable when the
 * scrape stored an author beside it. Reported so "the channel list is missing
 * channels" has a number attached instead of being a suspicion.
 */
/**
 * What the last rankChannels() call could not attribute.
 *
 * Module state rather than a second return value: every caller of rankChannels
 * already destructures an array, and the count is only ever wanted by the one
 * route that displays it.
 */
let lastUnattributed: UnattributedCount = { total: 0, byPlatform: {} }

export function unattributedLinks(): UnattributedCount {
  return lastUnattributed
}

export interface UnattributedCount {
  total: number
  byPlatform: Record<string, number>
}

export async function rankChannels(): Promise<ChannelRow[]> {
  const [videos, blockedUrls, stats] = await Promise.all([
    loadVideosJson().catch(() => []),
    getBlockedUrls().catch(() => [] as string[]),
    getLinkStats().catch(() => ({}) as Record<string, LinkStat>),
  ])
  // Refreshed counts first, so a channel's average reflects the live numbers
  // rather than whatever the scrape happened to capture months ago.
  overlayStats(videos as unknown as { url?: unknown }[], stats)
  const blocked = new Set(blockedUrls)

  const acc = new Map<string, Acc>()
  lastUnattributed = { total: 0, byPlatform: {} }
  for (const v of videos) {
    const url = String(v.url ?? '')
    const handle = channelOfRow(url, (v as { author?: unknown }).author)
    if (!handle) {
      // Counted rather than skipped in silence: these are links whose channel
      // we simply cannot name, and their absence from the list is the honest
      // answer to "why is this channel not here".
      const p = String((v as { platform?: unknown }).platform ?? '') || 'unknown'
      lastUnattributed.total++
      lastUnattributed.byPlatform[p] = (lastUnattributed.byPlatform[p] ?? 0) + 1
      continue
    }
    const s = siteOf(url)
    const key = channelKey(s, handle)
    const a = acc.get(key) ?? { handle, site: s, links: 0, active: 0, hearts: [], times: [] }
    a.links++
    if (!blocked.has(url)) a.active++
    const h = Number((v as { heart_count?: unknown }).heart_count ?? v.like_count)
    if (Number.isFinite(h) && h >= 0) a.hearts.push(h)
    const t = parsePostedDate(
      v.posted_date == null ? undefined : String(v.posted_date),
      v.scraped_at == null ? undefined : String(v.scraped_at)
    )
    if (t !== null) a.times.push(t)
    acc.set(key, a)
  }

  // Blocked counts come from the WHOLE blocked list, not from the pool: blocking
  // a link removes it from videos.json, so 98% of blocked links are no longer
  // there. Counting only the ones still in the pool made almost every channel
  // look 100% active. This mirrors what the admin Links page already does.
  // Keyed the same way as the pool, or a TikTok channel's blocks would be
  // charged against a same-named Instagram one.
  const blockedByChannel = new Map<string, number>()
  for (const url of blockedUrls) {
    const handle = handleOf(url)
    if (!handle) continue
    const key = channelKey(siteOf(url), handle)
    blockedByChannel.set(key, (blockedByChannel.get(key) ?? 0) + 1)
  }

  const now = Date.now()
  const rows: ChannelRow[] = []
  acc.forEach((a, key) => {
    const handle = a.handle
    // MEDIAN, not mean — the same reason as lib/dateScore.ts. A channel whose
    // typical video gets 7 likes and whose best got 4.2 million has a mean of
    // 377,726, and ranking it on that would send us back to mine a channel that
    // is not actually performing. Measured on the pool: 53% of channels have a
    // mean at least twice their median.
    const avgHearts = a.hearts.length ? medianOf(a.hearts) : null
    // Posting frequency: videos per day across the span we have seen. A single
    // dated post gives no span and so no rate — it scores neutral rather than
    // being read as "posts once a day".
    let perDay: number | null = null
    let lastPostDays: number | null = null
    if (a.times.length >= 2) {
      const min = Math.min(...a.times)
      const max = Math.max(...a.times)
      const days = (max - min) / 86_400_000
      perDay = days >= 1 ? a.times.length / days : a.times.length
      lastPostDays = Math.floor((now - max) / 86_400_000)
    } else if (a.times.length === 1) {
      lastPostDays = Math.floor((now - a.times[0]) / 86_400_000)
    }
    // An Instagram post URL carries no handle, so a blocked Instagram link
    // cannot be attributed to anyone — its channel would always read 100%
    // active, which is worse than reading unknown.
    const canAttributeBlocks = a.site !== 'instagram'
    const blockedTotal = canAttributeBlocks ? (blockedByChannel.get(key) ?? 0) : 0
    const judged = a.active + blockedTotal
    rows.push({
      handle,
      platform: a.site,
      links: a.links,
      active: a.active,
      blocked: blockedTotal,
      activePct: canAttributeBlocks && judged > 0 ? Math.round((a.active / judged) * 100) : null,
      avgHearts,
      perDay,
      lastPostDays,
      score: 0,
    })
  })

  // Percentile each signal over the channels that have it; a channel missing a
  // signal scores NEUTRAL on it (0.5) rather than worst, so a gap in our data
  // doesn't masquerade as a bad channel.
  const linkPct = percentiles(rows.map((r) => r.links))
  const heartPct = percentiles(rows.filter((r) => r.avgHearts !== null).map((r) => r.avgHearts as number))
  const freqPct = percentiles(rows.filter((r) => r.perDay !== null).map((r) => r.perDay as number))
  const activePct = percentiles(rows.filter((r) => r.activePct !== null).map((r) => r.activePct as number))

  const at = (m: Map<number, number>, v: number | null) =>
    v === null ? 0.5 : m.get(v) ?? 0.5

  for (const r of rows) {
    r.score =
      Math.round(
        (0.25 * at(linkPct, r.links) +
          0.25 * at(heartPct, r.avgHearts) +
          0.25 * at(freqPct, r.perDay) +
          0.25 * at(activePct, r.activePct)) *
          10000
      ) / 10000
  }
  // Best first; handle breaks ties so the order is stable across requests, which
  // the extract pass relies on to resume at an offset.
  rows.sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
  return rows
}
