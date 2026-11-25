// ── Reading a YouTube video's or a Reddit post's comments ───────────────────
//
// The comment checks began on TikTok alone, so a worker whose work is YouTube
// Shorts and Reddit threads was verified on the handful of TikTok links they
// happened to open. This module reads the other two, in the same shape the
// TikTok read has (lib/linkStats fetchComments), so lib/commentPresence can
// judge every platform by the same rules.
//
// BOTH NEED A KEY, and without one the platform is simply not checked:
//
//   YouTube  YOUTUBE_API_KEY — a free YouTube Data API v3 key (Google Cloud
//            console → enable "YouTube Data API v3" → Credentials → API key).
//            Reading costs 1 unit per 100 comments of a 10,000-unit daily quota.
//   Reddit   REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET — a "script" app made at
//            reddit.com/prefs/apps. Reddit answers 403 to anonymous reads from
//            servers (and, measured on 2026-11-24, from a home connection too).
//
// "Not checked" is not "missed": a platform without its key never reaches the
// window the block rules read (see verifiablePlatforms), so switching one on
// adds evidence and switching it off removes it — it can never invent a miss.

export type CheckPlatform = 'tiktok' | 'youtube' | 'reddit'

/** Which comment-checkable platform a link is on, or null. */
export function platformOfUrl(url: string): CheckPlatform | null {
  const u = String(url || '').toLowerCase()
  if (u.includes('tiktok.com')) return 'tiktok'
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  if (u.includes('reddit.com') || u.includes('redd.it')) return 'reddit'
  return null
}

export const youtubeEnabled = (): boolean => !!process.env.YOUTUBE_API_KEY?.trim()
export const redditEnabled = (): boolean =>
  !!process.env.REDDIT_CLIENT_ID?.trim() && !!process.env.REDDIT_CLIENT_SECRET?.trim()

/** The platforms whose comments can be read right now. TikTok needs nothing. */
export function verifiablePlatforms(): CheckPlatform[] {
  const out: CheckPlatform[] = ['tiktok']
  if (youtubeEnabled()) out.push('youtube')
  if (redditEnabled()) out.push('reddit')
  return out
}

/**
 * SQL that keeps only links on a checkable platform. `col` is the url column.
 * TikTok rows are additionally limited to the current TikTok account by the
 * callers that care (getRecentClickedLinks); the other two have no such date.
 */
export function verifiableUrlSql(col = 'url'): string {
  const parts = [`${col} ILIKE '%tiktok.com%'`]
  if (youtubeEnabled()) parts.push(`${col} ILIKE '%youtube.com%'`, `${col} ILIKE '%youtu.be%'`)
  if (redditEnabled()) parts.push(`${col} ILIKE '%reddit.com%'`)
  return `(${parts.join(' OR ')})`
}

/** One comment, whoever wrote it. */
export interface PlatformComment {
  /** Lowercased author name without '@' (YouTube handle, Reddit username). */
  author: string
  /** YouTube channel id (UC…), when the platform gives one. */
  authorId: string
  text: string
  /** When it was posted, ISO, or null. */
  postedAt: string | null
}

export interface PlatformRead {
  comments: PlatformComment[]
  /** What the platform says the post has, or null. */
  total: number | null
  /**
   * Every comment that COULD be theirs was read: the whole list, or — for
   * YouTube, read newest first — everything posted since they opened the link.
   */
  complete: boolean
  /** The link could not be read at all (no key, bad id, comments off, refused). */
  unresolved: boolean
}

const NONE: PlatformRead = { comments: [], total: null, complete: false, unresolved: true }

// ── YouTube ─────────────────────────────────────────────────────────────────

/** The 11-character video id in any YouTube link form, or null. */
export function youtubeVideoId(url: string): string | null {
  const s = String(url || '')
  const m =
    s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    s.match(/youtube\.com\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/) ||
    s.match(/[?&]v=([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}

/** '@handle' or 'UC…' channel id from a profile link, lowercased handle without '@'. */
export function youtubeIdentity(profileUrl: string | null | undefined): { handle: string | null; channelId: string | null } {
  const s = String(profileUrl ?? '')
  const h = s.match(/@([A-Za-z0-9._-]+)/)?.[1]
  const c = s.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1]
  return { handle: h ? h.toLowerCase() : null, channelId: c ?? null }
}

/** Pages of 100 read at most. Ten is 1,000 comments newer than the click. */
const YT_MAX_PAGES = 10
/** Slack on "posted after they opened it", for clock skew between systems. */
const POSTED_SLACK_MS = 60 * 60 * 1000

type Fetch = typeof fetch

export async function fetchYoutubeComments(
  url: string,
  /** When they opened the link. Comments older than this cannot be theirs. */
  since?: string | null,
  f: Fetch = fetch
): Promise<PlatformRead> {
  const key = process.env.YOUTUBE_API_KEY?.trim()
  const id = youtubeVideoId(url)
  if (!key || !id) return NONE
  const floor = since ? Date.parse(since) - POSTED_SLACK_MS : NaN
  const out: PlatformComment[] = []
  let token = ''
  let complete = false
  for (let page = 0; page < YT_MAX_PAGES; page++) {
    const q = new URLSearchParams({
      part: 'snippet,replies',
      videoId: id,
      maxResults: '100',
      order: 'time',
      textFormat: 'plainText',
      key,
    })
    if (token) q.set('pageToken', token)
    let data: {
      items?: {
        snippet?: { topLevelComment?: { snippet?: YtSnippet }; totalReplyCount?: number }
        replies?: { comments?: { snippet?: YtSnippet }[] }
      }[]
      nextPageToken?: string
    }
    try {
      const res = await f(`https://www.googleapis.com/youtube/v3/commentThreads?${q}`, {
        signal: AbortSignal.timeout(15000),
        cache: 'no-store',
      })
      // 403 commentsDisabled, 404 videoNotFound, quota — none of them a miss.
      if (!res.ok) return page === 0 ? NONE : { comments: out, total: null, complete: false, unresolved: false }
      data = await res.json()
    } catch {
      return page === 0 ? NONE : { comments: out, total: null, complete: false, unresolved: false }
    }
    let older = false
    for (const t of data.items ?? []) {
      const top = t.snippet?.topLevelComment?.snippet
      if (top) {
        out.push(ytComment(top))
        const at = Date.parse(top.publishedAt ?? '')
        if (Number.isFinite(floor) && Number.isFinite(at) && at < floor) older = true
      }
      for (const r of t.replies?.comments ?? []) if (r.snippet) out.push(ytComment(r.snippet))
    }
    // Newest first: once a page reaches comments older than the click, every
    // comment they could have posted has been seen.
    if (older || !data.nextPageToken) {
      complete = true
      break
    }
    token = data.nextPageToken
  }
  return { comments: out, total: null, complete, unresolved: false }
}

interface YtSnippet {
  authorDisplayName?: string
  authorChannelId?: { value?: string }
  textOriginal?: string
  textDisplay?: string
  publishedAt?: string
}

function ytComment(s: YtSnippet): PlatformComment {
  return {
    author: String(s.authorDisplayName ?? '').trim().replace(/^@/, '').toLowerCase(),
    authorId: String(s.authorChannelId?.value ?? ''),
    text: String(s.textOriginal ?? s.textDisplay ?? ''),
    postedAt: s.publishedAt ?? null,
  }
}

// ── Reddit ──────────────────────────────────────────────────────────────────

/** The post id (base36) in a Reddit link, or null. */
export function redditPostId(url: string): string | null {
  const s = String(url || '')
  return (s.match(/\/comments\/([a-z0-9]+)/i) || s.match(/redd\.it\/([a-z0-9]+)/i))?.[1]?.toLowerCase() ?? null
}

const REDDIT_UA = 'web:comment-presence-check:1.0'
let redditToken: { value: string; until: number } | null = null

async function redditAccessToken(f: Fetch): Promise<string | null> {
  if (redditToken && redditToken.until > Date.now() + 60_000) return redditToken.value
  const id = process.env.REDDIT_CLIENT_ID?.trim()
  const secret = process.env.REDDIT_CLIENT_SECRET?.trim()
  if (!id || !secret) return null
  try {
    const res = await f('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_UA,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const j = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!j.access_token) return null
    redditToken = { value: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 }
    return redditToken.value
  } catch {
    return null
  }
}

interface RedditThing {
  kind?: string
  data?: {
    author?: string
    body?: string
    created_utc?: number
    num_comments?: number
    children?: unknown[]
    count?: number
    replies?: { data?: { children?: RedditThing[] } } | ''
  }
}

export async function fetchRedditComments(url: string, f: Fetch = fetch): Promise<PlatformRead> {
  const id = redditPostId(url)
  if (!id) return NONE
  const token = await redditAccessToken(f)
  if (!token) return NONE
  let body: { data?: { children?: RedditThing[] } }[]
  try {
    const res = await f(
      `https://oauth.reddit.com/comments/${id}?sort=new&limit=500&depth=12&raw_json=1`,
      {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': REDDIT_UA },
        signal: AbortSignal.timeout(15000),
        cache: 'no-store',
      }
    )
    if (res.status === 401) redditToken = null
    if (!res.ok) return NONE
    body = await res.json()
  } catch {
    return NONE
  }
  if (!Array.isArray(body) || body.length < 2) return NONE
  const total = Number(body[0]?.data?.children?.[0]?.data?.num_comments)
  const out: PlatformComment[] = []
  let hidden = false
  const walk = (things: RedditThing[] | undefined) => {
    for (const t of things ?? []) {
      if (t.kind === 'more') {
        // "load more comments" — some are not in this answer. A stub with no
        // children is just Reddit's depth marker for an empty branch.
        if ((t.data?.children?.length ?? 0) > 0 || (t.data?.count ?? 0) > 0) hidden = true
        continue
      }
      if (t.kind !== 't1' || !t.data) continue
      const secs = Number(t.data.created_utc)
      out.push({
        author: String(t.data.author ?? '').toLowerCase(),
        authorId: '',
        text: String(t.data.body ?? ''),
        postedAt: Number.isFinite(secs) && secs > 1e9 ? new Date(secs * 1000).toISOString() : null,
      })
      if (t.data.replies && typeof t.data.replies === 'object') walk(t.data.replies.data?.children)
    }
  }
  walk(body[1]?.data?.children)
  return {
    comments: out,
    total: Number.isFinite(total) ? total : null,
    complete: !hidden,
    unresolved: false,
  }
}

// ── Recognising their comment by its words ──────────────────────────────────
//
// TikTok comments are matched by the @handle on the profile. YouTube's profile
// link is often missing or a different channel, and nobody registers a Reddit
// name at all — but every click stores the exact comment the server handed out
// (clicked_link.served_comment). A comment on the post saying that, posted after
// they opened the link, is theirs, and its author is then remembered as their
// account on that platform.

// Built with the constructor: the project's TS target rejects /u literals.
const NON_WORD_G = new RegExp('[^\\p{L}\\p{N}]+', 'gu')
const NON_WORD = new RegExp('[^\\p{L}\\p{N}]+', 'u')

/** Letters and digits only, lowercased: quotes, emoji, spacing and case vanish. */
export function commentKey(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(NON_WORD_G, '')
}

function words(s: string): string[] {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .split(NON_WORD)
    .filter((w) => w.length > 0)
}

/**
 * Is `posted` the comment they were given, allowing for small edits?
 *
 * Identical once punctuation, emoji, case and spacing are gone (so "purify text"
 * and "purifytext" agree); or, for comments of six words or more, at least 80%
 * of the words shared both ways. Short comments must match exactly — "this is
 * so good" is a sentence many strangers write.
 */
export function matchesServed(posted: string, served: string | null | undefined): boolean {
  if (!served) return false
  const a = commentKey(posted)
  const b = commentKey(served)
  if (a.length < 20 || b.length < 20) return false
  if (a === b) return true
  const wa = words(posted)
  const wb = words(served)
  if (wa.length < 6 || wb.length < 6) return false
  const sa = new Set(wa)
  const sb = new Set(wb)
  let shared = 0
  for (const w of Array.from(sa)) if (sb.has(w)) shared++
  return shared / sa.size >= 0.8 && shared / sb.size >= 0.8
}
