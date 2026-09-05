// Live engagement counts from TikTok's embed page.
//
// https://www.tiktok.com/embed/v2/<videoId> renders a __FRONTITY_CONNECT_STATE__
// script tag holding videoData.itemInfos — diggCount (likes), playCount (views),
// commentCount. It is a plain HTTP GET: no browser, no login, no API key, which
// is why the bio backfill uses the same page.
//
// The counts are stored in the link_stat table rather than written back into
// videos.json, so refreshing a batch is a handful of upserts instead of a 24 MB
// blob rewrite. They are overlaid onto the pool wherever it is read.

import type { LinkStat } from './db'

const STATE_RE = /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** The numeric video id in a TikTok URL, or null for anything else. */
export function tiktokVideoId(url: string): string | null {
  const m = url.match(/tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/i)
  return m?.[1] ?? null
}

/**
 * First numeric value stored under `key`, anywhere in the embed state.
 *
 * The blob's shape has changed before (itemInfos has lived at different depths),
 * so this walks rather than indexing a fixed path. Depth-capped because the
 * state is large and deeply self-referential in places.
 */
function findNumber(node: unknown, key: string, depth = 0): number | null {
  if (depth > 12 || node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findNumber(v, key, depth + 1)
      if (r !== null) return r
    }
    return null
  }
  const obj = node as Record<string, unknown>
  const direct = obj[key]
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct
  // Counts are sometimes serialised as strings.
  if (typeof direct === 'string' && /^\d+$/.test(direct)) return Number(direct)
  for (const v of Object.values(obj)) {
    const r = findNumber(v, key, depth + 1)
    if (r !== null) return r
  }
  return null
}

export interface FetchedStat {
  url: string
  hearts: number | null
  views: number | null
  // True for a TikTok "photo mode" post (an image carousel, not a video). Null
  // when the embed could not be read, so an unreadable link never overwrites a
  // known answer. Read from the same response as the counts — no extra request.
  isPhoto: boolean | null
}

/**
 * Is this embed state a photo post?
 *
 * A photo post carries videoData.imagePostInfo.displayImages and an empty video
 * (urls: [], duration: 0); a real video has neither. TikTok serves photo posts
 * under /video/<id> in search results and only rewrites the URL to /photo/<id>
 * in the browser, so the URL alone cannot tell them apart.
 */
function isPhotoPost(state: unknown): boolean | null {
  const hit = findNode(state, 'imagePostInfo')
  if (hit !== undefined) {
    const images = (hit as { displayImages?: unknown })?.displayImages
    return Array.isArray(images) ? images.length > 0 : hit !== null
  }
  // No imagePostInfo anywhere, but we did read a videoData block — a real video.
  return findNode(state, 'videoData') === undefined ? null : false
}

/** First value stored under `key` anywhere in the state, or undefined. */
function findNode(node: unknown, key: string, depth = 0): unknown {
  if (depth > 12 || node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findNode(v, key, depth + 1)
      if (r !== undefined) return r
    }
    return undefined
  }
  const obj = node as Record<string, unknown>
  if (key in obj) return obj[key]
  for (const v of Object.values(obj)) {
    const r = findNode(v, key, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

/**
 * Fetch one link's counts. Never throws — a failure is reported as nulls so a
 * single dead video can't abort a batch. Returning nulls also means the upsert
 * leaves any previously-stored value untouched.
 */
export async function fetchStat(url: string, timeoutMs = 12000): Promise<FetchedStat> {
  const id = tiktokVideoId(url)
  if (!id) return { url, hearts: null, views: null, isPhoto: null }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://www.tiktok.com/embed/v2/${id}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctl.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { url, hearts: null, views: null, isPhoto: null }
    const html = await res.text()
    const m = STATE_RE.exec(html)
    if (!m) return { url, hearts: null, views: null, isPhoto: null }
    const state = JSON.parse(m[1]) as unknown
    return {
      url,
      hearts: findNumber(state, 'diggCount'),
      views: findNumber(state, 'playCount'),
      isPhoto: isPhotoPost(state),
    }
  } catch {
    return { url, hearts: null, views: null, isPhoto: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch a list with a fixed number of workers in flight.
 *
 * `deadline` (epoch ms) stops the pass early and returns what finished, so the
 * route can always answer inside its own time budget instead of being killed
 * mid-write. Whatever was not reached is simply picked up by the next batch.
 */
export async function fetchStats(
  urls: string[],
  concurrency: number,
  deadline: number
): Promise<{ stats: FetchedStat[]; consumed: number }> {
  const stats: FetchedStat[] = []
  let next = 0
  let consumed = 0
  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return
      const i = next++
      if (i >= urls.length) return
      const s = await fetchStat(urls[i])
      consumed = Math.max(consumed, i + 1)
      stats.push(s)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return { stats, consumed }
}

/**
 * Overlay refreshed counts onto pool rows, in place. Returns how many changed.
 *
 * A refreshed heart count replaces BOTH heart_count and like_count: they are the
 * same measure (see lib/dateScore.ts), and like_count is what the links table
 * shows and what retireThreshold reads, so leaving it stale would show one number
 * and score another.
 */
export function overlayStats(
  rows: { url?: unknown; [k: string]: unknown }[],
  stats: Record<string, LinkStat>
): number {
  let n = 0
  for (const r of rows) {
    const s = stats[String(r.url ?? '')]
    if (!s) continue
    if (s.hearts !== null) {
      r.heart_count = s.hearts
      r.like_count = s.hearts
    }
    if (s.views !== null) r.view_count = s.views
    n++
  }
  return n
}

// ── Channel listing ──────────────────────────────────────────────────────────
// https://www.tiktok.com/embed/@<handle> renders the channel's most recent
// videos in its __FRONTITY_CONNECT_STATE__ (videoList: id, desc, playCount).
// The profile page proper is blocked to plain GETs — it returns a ~1.4 KB stub —
// so this embed page is the only browserless way to list a channel's videos.
//
// ROUGHLY A DOZEN IS THE CEILING (8–13 observed): count and cursor query params
// are accepted but ignored, so there is no paging. That is enough to catch up a
// channel that posted a handful since the last run; it cannot backfill a channel
// we have never scraped properly — that still needs scrape_channels.py.

const CHANNEL_STATE_RE =
  /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/

export interface ChannelVideo {
  id: string
  url: string
  title: string
  views: number | null
}

/**
 * The channel's ten most recent videos, newest first. Empty on any failure —
 * a channel that is gone, renamed or rate-limited must not abort a sweep.
 */
export async function fetchChannelVideos(
  handle: string,
  timeoutMs = 15000
): Promise<ChannelVideo[]> {
  const clean = handle.replace(/^@/, '').trim()
  if (!/^[A-Za-z0-9._]{1,80}$/.test(clean)) return []
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://www.tiktok.com/embed/@${clean}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctl.signal,
      cache: 'no-store',
    })
    if (!res.ok) return []
    const m = CHANNEL_STATE_RE.exec(await res.text())
    if (!m) return []
    const state = JSON.parse(m[1]) as {
      source?: { data?: Record<string, { videoList?: unknown }> }
    }
    const data = state.source?.data ?? {}
    // The page keys its payload by its own path, so find it rather than guess.
    const key = Object.keys(data).find((k) => k.toLowerCase().startsWith('/embed/@'))
    const list = key ? data[key]?.videoList : null
    if (!Array.isArray(list)) return []
    const out: ChannelVideo[] = []
    for (const v of list) {
      const row = v as { id?: unknown; desc?: unknown; playCount?: unknown }
      const id = String(row.id ?? '')
      if (!/^\d{15,25}$/.test(id)) continue
      const views = Number(row.playCount)
      out.push({
        id,
        url: `https://www.tiktok.com/@${clean}/video/${id}`,
        title: typeof row.desc === 'string' ? row.desc : '',
        views: Number.isFinite(views) && views >= 0 ? views : null,
      })
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export interface VideoDetail {
  url: string
  account: string
  title: string
  bio: string
  hearts: number | null
  views: number | null
  comments: number | null
  shares: number | null
  /** Real posted date as YYYY-MM-DD, from createTime — not a relative string. */
  postedDate: string
}

/**
 * Everything the verify list wants about one video, from its embed page.
 *
 * This is the same page fetchStat reads, so a new link arrives with its real
 * like/view/comment/share counts, its caption, its channel's bio, and an EXACT
 * posted date — none of the "5-19" ambiguity the search scraper produces.
 */
export async function fetchVideoDetail(
  url: string,
  timeoutMs = 15000
): Promise<VideoDetail | null> {
  const id = tiktokVideoId(url)
  if (!id) return null
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://www.tiktok.com/embed/v2/${id}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctl.signal,
      cache: 'no-store',
    })
    if (!res.ok) return null
    const m = STATE_RE.exec(await res.text())
    if (!m) return null
    const state = JSON.parse(m[1]) as unknown
    const created = findNumber(state, 'createTime')
    const str = (key: string): string => {
      const v = findString(state, key)
      return typeof v === 'string' ? v : ''
    }
    return {
      url,
      account: str('uniqueId'),
      title: str('text'),
      bio: str('signature'),
      hearts: findNumber(state, 'diggCount'),
      views: findNumber(state, 'playCount'),
      comments: findNumber(state, 'commentCount'),
      shares: findNumber(state, 'shareCount'),
      // createTime is seconds since epoch; the verify table stores a date string.
      postedDate: created ? new Date(created * 1000).toISOString().slice(0, 10) : '',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** First string value stored under `key`, anywhere in the state. */
function findString(node: unknown, key: string, depth = 0): string | null {
  if (depth > 12 || node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findString(v, key, depth + 1)
      if (r !== null) return r
    }
    return null
  }
  const obj = node as Record<string, unknown>
  if (typeof obj[key] === 'string') return obj[key] as string
  for (const v of Object.values(obj)) {
    const r = findString(v, key, depth + 1)
    if (r !== null) return r
  }
  return null
}

// ── Reading a video's comments ───────────────────────────────────────────────
// https://www.tiktok.com/api/comment/list/?aweme_id=<id>&count=50&cursor=0&aid=1988
// answers a PLAIN GET with the comment list — text, author handle, likes, time.
// No browser, no login, and (unlike /api/post/item_list) no signed parameters.
//
// It is SLOW compared with the embed page: 1–5s per video, occasionally ~19s,
// and concurrency does not help much. Fine for checking one user's handful of
// links; useless for sweeping the pool.

/**
 * Resolve a vt.tiktok.com / vm.tiktok.com share link to its canonical URL.
 *
 * This matters more than it looks: users submit their proof links from the
 * TikTok APP, which produces short links exclusively — every one of the 298
 * sample URLs on record is a vt.tiktok.com link. Without this the video id
 * cannot be read and verification silently checks nothing at all.
 *
 * Returns the input unchanged when it is already canonical or cannot resolve.
 */
export async function resolveShortLink(url: string, timeoutMs = 20000): Promise<string> {
  if (!/\/\/(?:vt|vm)\.tiktok\.com\//i.test(url)) return url
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    // `redirect: 'follow'` and read res.url — a HEAD with manual redirect works
    // too, but following lets one call cope with a chain of hops.
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: ctl.signal,
      cache: 'no-store',
    })
    const final = res.url || url
    // Strip TikTok's share tracking params so the result is a clean video URL.
    return tiktokVideoId(final) ? final.split('?')[0] : url
  } catch {
    return url
  } finally {
    clearTimeout(timer)
  }
}

export interface VideoComment {
  /** Commenter's @handle, lowercased, without the '@'. */
  username: string
  text: string
  likes: number
  /**
   * The commenter's numeric TikTok account id.
   *
   * Worth carrying because it is the ONLY place this number is obtainable: the
   * embed page, the full profile page, oEmbed and /api/user/detail all withhold
   * it, and it is a snowflake — its top 32 bits are the second the account was
   * created. See accountCreatedAt in lib/tiktokId.
   */
  uid: string
}

export interface CommentRead {
  comments: VideoComment[]
  /** What TikTok says the video has, or null when we never got an answer. */
  total: number | null
  /** True when we read every comment TikTok reports. */
  complete: boolean
  /** The share link could not be resolved to a video at all. */
  unresolved: boolean
}

/**
 * Comments on one video, with enough metadata to judge the result.
 *
 * The extra fields exist because ABSENCE is the risky answer here: a video with
 * 540 comments returns 150 in three pages, so "their name isn't in what we read"
 * is not "they didn't comment". A caller deciding whether someone gets paid has
 * to be able to tell a complete read from a partial one, and both from a link
 * that never resolved.
 */
export async function fetchComments(
  videoUrl: string,
  maxPages = 3,
  timeoutMs = 20000
): Promise<CommentRead> {
  // Share links (vt.tiktok.com/...) carry no video id until resolved, and that
  // is the only form users actually submit.
  const canonical = tiktokVideoId(videoUrl) ? videoUrl : await resolveShortLink(videoUrl)
  const id = tiktokVideoId(canonical)
  if (!id) return { comments: [], total: null, complete: false, unresolved: true }
  const out: VideoComment[] = []
  const seen = new Set<string>()
  let cursor = 0
  let total: number | null = null
  let exhausted = false

  for (let page = 0; page < maxPages; page++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(
        `https://www.tiktok.com/api/comment/list/?aweme_id=${id}&count=50&cursor=${cursor}&aid=1988`,
        {
          headers: { 'User-Agent': UA, Referer: canonical, 'Accept-Language': 'en-US,en;q=0.9' },
          signal: ctl.signal,
          cache: 'no-store',
        }
      )
      if (!res.ok) break
      const body = await res.text()
      // A throttled request answers 200 with an empty body rather than an error.
      if (!body.trim()) break
      const data = JSON.parse(body) as {
        comments?: {
          cid?: unknown
          text?: unknown
          digg_count?: unknown
          user?: { unique_id?: unknown; uid?: unknown }
        }[]
        has_more?: unknown
        cursor?: unknown
        total?: unknown
      }
      if (total === null && Number.isFinite(Number(data.total))) total = Number(data.total)
      const list = Array.isArray(data.comments) ? data.comments : []
      for (const c of list) {
        const cid = String(c.cid ?? '')
        if (cid && seen.has(cid)) continue
        if (cid) seen.add(cid)
        const username = String(c.user?.unique_id ?? '').trim().toLowerCase()
        if (!username) continue
        out.push({
          username,
          text: String(c.text ?? ''),
          likes: Number(c.digg_count) || 0,
          uid: String(c.user?.uid ?? '').trim(),
        })
      }
      if (!data.has_more || list.length === 0) {
        exhausted = true
        break
      }
      cursor = Number(data.cursor) || cursor + list.length
    } catch {
      break
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    comments: out,
    total,
    // Complete needs BOTH: TikTok said there was no more, AND we hold as many
    // as it reports. `has_more: 0` alone is not enough — `total` counts REPLIES,
    // which the top-level list never returns, so a video can report 122 and hand
    // back 78 with no more pages. Someone who replied to a comment rather than
    // posting their own is in that gap, and calling it complete would turn
    // "we cannot see replies" into "they did not comment".
    complete: exhausted && (total === null || out.length >= total),
    unresolved: false,
  }
}
