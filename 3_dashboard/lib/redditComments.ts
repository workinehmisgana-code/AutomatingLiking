// ── REDDIT: COMMENTS WRITTEN FOR EACH POST ───────────────────────────────────
//
// Every other platform is served from a product's bank, written per AUDIENCE:
// a few hundred comments that fit any video of a kind. That works under a
// TikTok video, which is scrolled past. A Reddit thread is read, and a comment
// that does not answer the post it sits under is spotted at once.
//
// So a Reddit post gets its OWN comments: up to REDDIT_COMMENTS_PER_POST, written
// from the post's title (and its text, when Reddit lets us read it) as different
// redditors answering it, each naming the product once. They are stored per
// (post, product) and each worker sent to the post is handed one nobody has been
// handed there yet; once all ten are used they repeat at random.
//
// Written the first time a worker opens the post, unless the warm-up cron
// (/api/cron/reddit-comments) got there first. Anything that fails here falls
// back to the product's ordinary bank (serveCommentForUrl), never to nothing.

import { pool, getProductCommentSettings } from './db'
import { llmChat } from './llm'
import { canonicaliseMention } from './commentGen'
import { redditCommentSystem, redditCommentUser, REDDIT_COMMENTS_PER_POST } from './prompts'
import { COMMENT_WORD_MIN, COMMENT_WORD_MAX, type CommentStyle, type Product } from './config'

export { REDDIT_COMMENTS_PER_POST }

/** Words a Reddit comment may run to. Reddit comments are longer than TikTok's. */
const REDDIT_WORDS = { min: 6, max: 110 }

let tableReady: Promise<void> | null = null
function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS reddit_post_comment (
           url          TEXT NOT NULL,
           product      TEXT NOT NULL,
           post_title   TEXT,
           post_body    TEXT,
           comments     JSONB NOT NULL DEFAULT '[]'::jsonb,
           model        TEXT,
           generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           PRIMARY KEY (url, product)
         )`
      )
      .then(() => undefined)
      .catch((e) => {
        tableReady = null
        throw e
      })
  }
  return tableReady
}

export interface RedditPost {
  subreddit: string
  title: string
  body: string
}

/** The words of the URL's slug: /r/x/comments/abc123/why_does_turnitin_flag/ → "why does turnitin flag". */
function slugTitle(url: string): string {
  const m = url.match(/\/comments\/[^/]+\/([^/?#]+)/)
  return m ? decodeURIComponent(m[1]).replace(/[_-]+/g, ' ').trim() : ''
}

/**
 * What the post says. The title the scraper saved (link_title) first; Reddit's
 * JSON view of the post for the body, when it answers — it often refuses
 * server addresses, so that is a bonus, not a requirement; and the URL's slug
 * when there is nothing else.
 */
export async function readRedditPost(url: string): Promise<RedditPost> {
  const subreddit = url.match(/\/r\/([^/]+)/)?.[1] ?? ''
  let title = ''
  let body = ''
  try {
    const { rows } = await pool.query<{ title: string }>(
      'SELECT title FROM link_title WHERE url = $1',
      [url]
    )
    title = String(rows[0]?.title ?? '').trim()
  } catch {
    /* table missing: use the slug */
  }
  try {
    const res = await fetch(url.split('?')[0].replace(/\/?$/, '/') + '.json?raw_json=1', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(3500),
      cache: 'no-store',
    })
    if (res.ok) {
      const data = (await res.json()) as Array<{ data?: { children?: Array<{ data?: { title?: string; selftext?: string } }> } }>
      const post = data?.[0]?.data?.children?.[0]?.data
      if (post?.title) title = String(post.title).trim()
      body = String(post?.selftext ?? '').trim()
    }
  } catch {
    /* Reddit refused or timed out: the title is enough */
  }
  if (!title) title = slugTitle(url)
  return { subreddit, title, body }
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

/** The model's lines, kept only when they are usable Reddit comments that name the product once. */
export function cleanRedditComments(product: Product, lines: unknown, style: CommentStyle): string[] {
  if (!Array.isArray(lines)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of lines) {
    if (typeof raw !== 'string') continue
    let s = raw.trim().replace(/^["'\s]+|["'\s]+$/g, '')
    if (!s) continue
    // Names the product, written the admin's way (split or joined, unquoted).
    const named = canonicaliseMention(s, product, style)
    if (named === null) continue
    s = named
    // "a acoustictext" → "an acoustictext" (the name-inside-the-sentence style).
    s = s.replace(/\b([Aa]) (?=[aeiouAEIOU])/g, '$1n ')
    if (/https?:\/\/|www\.|#\w/i.test(s)) continue
    // Ad language the prompt forbids; the model still slips into it now and then.
    if (/game[\s-]*changer|highly recommend|check(ing)? (it )?out|life[\s-]*saver|hands down/i.test(s)) continue
    const n = words(s)
    if (n < REDDIT_WORDS.min || n > REDDIT_WORDS.max) continue
    const key = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out.slice(0, REDDIT_COMMENTS_PER_POST)
}

/**
 * The comment strings in the model's answer. Long free text inside JSON is
 * where a model slips (an unescaped quote in one comment); rather than lose the
 * other nine, each well-formed string is salvaged on its own.
 */
export function parseRedditComments(content: string): string[] {
  try {
    const c = (JSON.parse(content) as { comments?: unknown })?.comments
    if (Array.isArray(c)) return c.filter((x): x is string => typeof x === 'string')
  } catch {
    /* salvaged below */
  }
  const out: string[] = []
  for (const m of Array.from(content.matchAll(/"((?:[^"\\\n]|\\.){20,})"/g))) {
    try {
      out.push(JSON.parse(`"${m[1]}"`) as string)
    } catch {
      /* that one is lost */
    }
  }
  return out
}

/** Write (or rewrite) the comments for one post and product, and store them. */
export async function generateRedditComments(url: string, product: Product): Promise<string[]> {
  await ensureTable()
  const post = await readRedditPost(url)
  const { style } = await getProductCommentSettings(product, {
    min: COMMENT_WORD_MIN,
    max: COMMENT_WORD_MAX,
  })
  // Asked for a couple more than kept: the filter drops the odd one.
  const ask = REDDIT_COMMENTS_PER_POST + 2
  let kept: string[] = []
  let model = ''
  for (let attempt = 0; attempt < 2 && kept.length < REDDIT_COMMENTS_PER_POST / 2; attempt++) {
    const r = await llmChat({
      temperature: 1.0,
      jsonObject: true,
      maxTokens: 6000,
      timeoutMs: 25_000,
      messages: [
        { role: 'system', content: redditCommentSystem(product, style, ask) },
        { role: 'user', content: redditCommentUser(post) },
      ],
    })
    model = r.model
    const more = cleanRedditComments(product, parseRedditComments(r.content), style)
    kept = cleanRedditComments(product, [...kept, ...more], style)
  }
  if (kept.length === 0) throw new Error('No usable Reddit comments returned')
  await pool.query(
    `INSERT INTO reddit_post_comment (url, product, post_title, post_body, comments, model, generated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
     ON CONFLICT (url, product) DO UPDATE SET
       post_title = EXCLUDED.post_title, post_body = EXCLUDED.post_body,
       comments = EXCLUDED.comments, model = EXCLUDED.model, generated_at = now()`,
    [url, product, post.title.slice(0, 500), post.body.slice(0, 4000), JSON.stringify(kept), model]
  )
  return kept
}

/** The stored comments for one post and product ([] when none yet). */
export async function storedRedditComments(url: string, product: string): Promise<string[]> {
  await ensureTable()
  const { rows } = await pool.query<{ comments: unknown }>(
    'SELECT comments FROM reddit_post_comment WHERE url = $1 AND product = $2',
    [url, product]
  )
  const c = rows[0]?.comments
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []
}

/** Which of `urls` already have comments stored (for any product). */
export async function redditUrlsWithComments(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set()
  await ensureTable()
  const { rows } = await pool.query<{ url: string }>(
    'SELECT DISTINCT url FROM reddit_post_comment WHERE url = ANY($1::text[])',
    [urls]
  )
  return new Set(rows.map((r) => r.url))
}

/**
 * The comment to hand the next worker on this post: one of its own, not yet
 * handed to anyone on this post; at random among all of them once every one
 * has been. Writes the set first when there is none. null when it cannot.
 */
export async function pickRedditComment(url: string, product: Product): Promise<string | null> {
  let comments = await storedRedditComments(url, product)
  if (comments.length === 0) comments = await generateRedditComments(url, product)
  if (comments.length === 0) return null
  const { rows } = await pool
    .query<{ c: string }>(
      `SELECT lower(btrim(served_comment)) AS c FROM clicked_link
        WHERE url = $1 AND served_comment IS NOT NULL`,
      [url]
    )
    .catch(() => ({ rows: [] as { c: string }[] }))
  const used = new Set(rows.map((r) => r.c))
  const fresh = comments.filter((c) => !used.has(c.trim().toLowerCase()))
  const from = fresh.length > 0 ? fresh : comments
  return from[Math.floor(Math.random() * from.length)]
}

/**
 * WARM-UP: write the comments for Reddit posts in the pool that have none, so
 * the first worker on a post is not kept waiting for the model. Newest-ranked
 * first (search rank, then posted-date score), `limit` posts per call, in
 * parallel. Blocked posts are skipped. Returns what it did.
 */
export async function warmRedditComments(
  limit = 8
): Promise<{ pending: number; written: number; failed: number; errors: string[] }> {
  const { loadVideosJson } = await import('./videos')
  const { getBlockedPoolUrls } = await import('./db')
  const { productOrderForUrl } = await import('./serveComment')
  const [videos, blocked] = await Promise.all([
    loadVideosJson(),
    getBlockedPoolUrls().catch(() => [] as string[]),
  ])
  const skip = new Set(blocked)
  const reddit = videos
    .filter((v) => v.url && /reddit\.com\//i.test(v.url) && !skip.has(v.url))
    .sort(
      (a, b) =>
        (a.search_rank ?? 1e9) - (b.search_rank ?? 1e9) || (b.date_score ?? 0) - (a.date_score ?? 0)
    )
    .map((v) => v.url)
  const done = await redditUrlsWithComments(reddit)
  const todo = reddit.filter((u) => !done.has(u))
  const batch = todo.slice(0, limit)
  const errors: string[] = []
  let written = 0
  await Promise.all(
    batch.map(async (url) => {
      try {
        const { order } = await productOrderForUrl(url)
        if (order.length === 0) return
        await generateRedditComments(url, order[0] as Product)
        written++
      } catch (e) {
        errors.push(String((e as Error)?.message ?? e).slice(0, 200))
      }
    })
  )
  return { pending: todo.length - written, written, failed: errors.length, errors: errors.slice(0, 3) }
}
