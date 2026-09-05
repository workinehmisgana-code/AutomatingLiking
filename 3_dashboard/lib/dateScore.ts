// Composite scoring for the "posted date" cluster dimension.
//
// That dimension used to be recency alone. It now blends three signals, so the
// clusters put forward links that are new AND worth commenting on rather than
// merely new:
//
//   recency   — how new the post is
//   isVideo   — videos only; photo/slideshow posts miss this
//   hearts    — the TYPICAL (median) like/heart count of the video's CHANNEL
//
// The weights are ADMIN-SET (the Recluster modal, stored in app_state) and
// default to DEFAULT_DATE_WEIGHTS in config.
//
// Every component is a PERCENTILE across the pool, not a raw value. A raw blend
// is unusable here: like counts span 0 to millions, so one viral channel would
// swamp the other two signals entirely, and dates in ms would dwarf a 0/1 flag.
// Percentiles put all three on the same 0–1 footing and make the weights mean
// what they say.
//
// Scores are computed ONCE PER UPLOAD (see /api/upload) and stored on the row,
// because the recency and heart components are percentiles that need the whole
// pool to normalise against —
// something a per-request serve path should not be recomputing.

import { type DateWeights, DEFAULT_DATE_WEIGHTS, normalizeDateWeights } from './config'
import { parsePostedDate } from './cluster'

export interface Scorable {
  url?: unknown
  platform?: unknown
  posted_date?: unknown
  scraped_at?: unknown
  like_count?: unknown
  /** Real LIKE count, when we have one (channel scrapes give diggCount). */
  heart_count?: unknown
  date_score?: unknown
  // The three components behind date_score, kept so the admin table can show
  // WHY a link sits where it does. Short keys on purpose: these are written to
  // every row of a ~24 MB videos.json, and `recency_percentile` three times over
  // 93k rows is megabytes of key names for no benefit.
  ds_r?: unknown
  ds_v?: unknown
  ds_h?: unknown
}

/**
 * The heart (like) count for one link, or null when we genuinely don't know it.
 *
 * Both TikTok scrapers give a real like count, so both fields are usable:
 *
 *  - CHANNEL scrapes read diggCount into heart_count (and the verify-links merge
 *    copies it into like_count as well).
 *  - SEARCH scrapes read the badge on each result card into like_count. That
 *    element is named `data-e2e="video-views"`, which is a TikTok misnomer — it
 *    holds the LIKE count. Verified against the embed endpoint on a 10-link
 *    sample: every stored value matched diggCount, none matched playCount.
 *
 * heart_count is preferred only because it is the more direct reading; like_count
 * is the same measure and is the one most of the pool actually has.
 *
 * null means "unknown", deliberately not the same as 0: a link with no like data
 * scores neutral rather than sinking to the bottom of the pool.
 */
function heartsOf(r: Scorable, url: string): number | null {
  const num = (raw: unknown): number | null => {
    if (raw == null || raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  const isTikTok = String(r.platform ?? '').toLowerCase() === 'tiktok' || /tiktok\.com/i.test(url)
  if (!isTikTok) return num(r.like_count)
  return num(r.heart_count) ?? num(r.like_count)
}

/**
 * The channel a link came from, or null when the URL doesn't carry one.
 *
 * YouTube /watch?v= links identify a video but not its channel, so those fall
 * back to their own like count rather than a channel average.
 */
export function channelOf(url: string): string | null {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
  if (tt) return `tiktok:${tt[1].toLowerCase()}`
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return `youtube:${yt[1].toLowerCase()}`
  const ig = url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)
  if (ig) return `instagram:${ig[1].toLowerCase()}`
  return null
}

/**
 * Is this a video rather than a photo/slideshow post?
 *
 * `isPhoto` is the flag the counts refresh reads off the embed page, and when
 * it is known it WINS — TikTok serves photo-mode posts under /video/<id> and
 * only rewrites the URL to /photo/<id> in the browser, so roughly a quarter of
 * the pool's /video/ links are really carousels that the URL cannot expose.
 *
 * Falling back to the URL: TikTok slideshows use /photo/, and an Instagram /p/
 * post is a photo where /reel/ is video. Anything else (YouTube) is video.
 */
export function isVideoPost(url: string, isPhoto?: boolean | null): boolean {
  if (isPhoto === true) return false
  if (isPhoto === false) return true
  if (/tiktok\.com\/@[^/]+\/photo\//i.test(url)) return false
  if (/instagram\.com\/[^/]+\/p\//i.test(url)) return false
  if (/instagram\.com\/p\//i.test(url)) return false
  return true
}

/**
 * Percentile rank of each value across the LINKS, 0 (lowest) … 1 (highest).
 *
 * Ranked over rows, not over distinct values. Ranking distinct values sounds
 * equivalent but is not, on a distribution like ours: a handful of viral posts
 * contribute thousands of distinct high like-counts while everyday counts repeat
 * across many links, so the distinct set is dominated by the tail and 98% of the
 * pool got squashed below 0.2 — which also made the 0.5 "unknown" fallback beat
 * almost every link that had real data.
 *
 * Ties share the midpoint of their run, so the many links on the same common
 * value get one percentile rather than an arbitrary spread. A single distinct
 * value scores 1 — with nothing to compare against the signal carries no
 * information and shouldn't penalise anyone.
 */
function percentiles(values: number[]): Map<number, number> {
  const out = new Map<number, number>()
  const n = values.length
  if (n === 0) return out
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted[0] === sorted[n - 1]) {
    out.set(sorted[0], 1)
    return out
  }
  // Walk runs of equal values; each run's members share its midpoint rank.
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && sorted[j + 1] === sorted[i]) j++
    out.set(sorted[i], (i + j) / 2 / (n - 1))
    i = j + 1
  }
  return out
}

/**
 * Compute and attach `date_score` (0–1) to every row, in place.
 *
 * Returns how many rows were scored. Rows with no parseable posted date get a
 * recency component of 0 rather than being dropped — they still carry their video
 * and heart signal, so an undated but well-liked video outranks an undated photo
 * nobody engaged with.
 */
export function computeDateScores(
  rows: Scorable[],
  weights: DateWeights = DEFAULT_DATE_WEIGHTS,
  // Optional lookup into the refreshed link_stat flags. Returning null/undefined
  // for a URL means "not checked yet", which falls back to the URL heuristic —
  // so passing nothing behaves exactly as before.
  photoOf?: (url: string) => boolean | null | undefined
): number {
  if (rows.length === 0) return 0
  // Normalised here too, not just at the call site: a caller passing raw
  // percentages (30/10/60) would otherwise produce scores far outside 0–1.
  const w = normalizeDateWeights(weights)

  const urls = rows.map((r) => String(r.url ?? ''))
  const times = rows.map((r) =>
    parsePostedDate(
      r.posted_date == null ? undefined : String(r.posted_date),
      r.scraped_at == null ? undefined : String(r.scraped_at)
    )
  )
  // null = unknown (see heartsOf): excluded from the distribution rather than
  // counted as zero, so "we never captured it" isn't read as "nobody liked it".
  const hearts = rows.map((r, i) => heartsOf(r, urls[i]))

  // Recency percentile over the links that actually have a date.
  const datedTimes = times.filter((t): t is number => t !== null)
  const timePct = percentiles(datedTimes)

  // Hearts: the typical like count of the video's CHANNEL, not the video's own.
  //
  // A post's own like count is unusable next to a recency weight, because it is
  // partly a measure of AGE: a video published this morning has few likes because
  // it is new, not because it is weak, so scoring it on its own count penalises
  // exactly the fresh posts the recency term is meant to promote. A channel
  // channel figure is stable from the moment a video appears, which makes a new
  // post from a reliably-liked channel predictable rather than penalised.
  //
  // Only links with a known count feed their channel's figure; a channel with no
  // data at all contributes nothing rather than a zero.
  const channelHearts = new Map<string, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const ch = channelOf(urls[i])
    const h = hearts[i]
    if (ch === null || h === null) continue
    const list = channelHearts.get(ch)
    if (list) list.push(h)
    else channelHearts.set(ch, [h])
  }

  // MEDIAN, not mean.
  //
  // A mean is exactly what one viral video destroys, and this pool is full of
  // them. Measured over 129,029 links: 726 of 1,364 channels — 53% — had a mean
  // at least twice their median, and 48,805 links belonged to one. getconch.ai
  // has a median of 7 likes and a mean of 377,726, because a single video did
  // 4.2 million; every one of its links was riding that into a top cluster.
  //
  // The percentile step below cannot undo this. It ranks channels against each
  // other, which makes it immune to one channel being enormous — but not to a
  // channel's own figure being wrong before it arrives. The median is the number
  // the average was meant to be: what this channel typically gets.
  //
  // Everything else here was already outlier-proof and stays that way: scores are
  // percentiles, which ignore magnitude, and clusters are equal-COUNT chunks of a
  // sorted list, so no single value can stretch a bucket.
  const medianOf = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    const mid = s.length >> 1
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }

  // The value each link is ranked on: its channel's typical count, or its own
  // when the URL carries no channel (YouTube video ids) or its channel has no
  // data at all — better to use what we do know than to fall back to neutral.
  const channelMedian = new Map<string, number>()
  channelHearts.forEach((hs, ch) => channelMedian.set(ch, medianOf(hs)))
  const heartVals = rows.map((_, i) => {
    const ch = channelOf(urls[i])
    const m = ch === null ? undefined : channelMedian.get(ch)
    return m !== undefined ? m : hearts[i]
  })
  const heartPct = percentiles(heartVals.filter((h): h is number => h !== null))

  for (let i = 0; i < rows.length; i++) {
    const t = times[i]
    const recency = t === null ? 0 : timePct.get(t) ?? 0
    const video = isVideoPost(urls[i], photoOf?.(urls[i]) ?? null) ? 1 : 0
    // A link with no heart data anywhere — not even from its channel — scores
    // NEUTRAL, not worst: that is a gap in our scraping, and 0 would sink every
    // such link to the bottom of the pool.
    const h = heartVals[i]
    const heartScore = h === null ? 0.5 : heartPct.get(h) ?? 0.5

    const score = w.recency * recency + w.isVideo * video + w.hearts * heartScore

    // Rounded: it only ever drives an ordering, and short numbers keep
    // videos.json (re-read on every dashboard render) from bloating.
    rows[i].date_score = Math.round(score * 10000) / 10000
    // The parts, at 3 decimals — enough to explain a position, small enough that
    // storing them on every row costs little.
    rows[i].ds_r = Math.round(recency * 1000) / 1000
    rows[i].ds_v = video
    rows[i].ds_h = Math.round(heartScore * 1000) / 1000
  }
  return rows.length
}
