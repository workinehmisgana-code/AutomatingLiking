// ── COMMENT REMOVAL MODE ─────────────────────────────────────────────────────
//
// The admin lists links and the workers whose comment on each must come down
// (the "null" comments pasted while a genre had nothing to serve were the first
// case). While a worker has any left, the app stops serving links and switches
// to removal mode: it opens each listed link and the worker deletes their
// comment there, then taps "Removed". The server reads the video and only
// crosses a link off once the comment is gone. When none are left, the app goes
// back to normal commenting by itself.
//
// TikTok is checked against the video. YouTube and Reddit are checked when
// their keys are set (lib/platformComments); anywhere else, and wherever the
// comments cannot be read (Instagram), the worker's word is taken. A TikTok read that
// stops early proves nothing, so the link stays on their list until a full read.

import { pool, ensureUserProfileTable, getPlatformAccounts } from './db'
import { fetchComments } from './linkStats'
import { handleFromProfile } from './commentPresence'
import {
  platformOfUrl,
  fetchYoutubeComments,
  fetchRedditComments,
  youtubeEnabled,
  redditEnabled,
  youtubeIdentity,
  commentKey,
} from './platformComments'

let ready: Promise<void> | null = null
function ensureTable(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS comment_removal (
           id          BIGSERIAL PRIMARY KEY,
           user_id     TEXT NOT NULL,
           url         TEXT NOT NULL,
           -- Only comments saying this count ("null"). NULL = any comment of theirs.
           match_text  TEXT,
           created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
           -- Set once it is gone. done_how: 'verified' (read off the video),
           -- 'worker' (their word: the video could not be read), 'admin'.
           done_at     TIMESTAMPTZ,
           done_how    TEXT,
           -- The last check that found it still there, and what it said.
           checked_at  TIMESTAMPTZ,
           still_text  TEXT,
           UNIQUE (user_id, url)
         );
         CREATE INDEX IF NOT EXISTS comment_removal_pending ON comment_removal (user_id) WHERE done_at IS NULL;
         -- The TikTok username that posted the comment (from the admin's list),
         -- checked alongside the handle on their profile.
         ALTER TABLE comment_removal ADD COLUMN IF NOT EXISTS handle TEXT;`
      )
      .then(() => undefined)
      .catch((e) => {
        ready = null
        throw e
      })
  }
  return ready
}

export interface RemovalItem {
  id: number
  url: string
  matchText: string | null
}

/** The links this worker still has to clean up, oldest first. */
export async function pendingRemovals(userId: string): Promise<RemovalItem[]> {
  await ensureTable()
  const { rows } = await pool.query<{ id: string; url: string; match_text: string | null }>(
    `SELECT id, url, match_text FROM comment_removal
      WHERE user_id = $1 AND done_at IS NULL ORDER BY created_at, id`,
    [userId]
  )
  return rows.map((r) => ({ id: Number(r.id), url: r.url, matchText: r.match_text }))
}

/** Is this worker in removal mode? Fails OPEN (false): a database hiccup must not stop everybody's work. */
export async function inRemovalMode(userId: string): Promise<boolean> {
  try {
    await ensureTable()
    const { rows } = await pool.query(
      'SELECT 1 FROM comment_removal WHERE user_id = $1 AND done_at IS NULL LIMIT 1',
      [userId]
    )
    return rows.length > 0
  } catch {
    return false
  }
}

/**
 * Who a line of the admin's list names: an @tiktok handle, an email, or a user
 * id. Returns the user id, or null.
 */
async function resolveWho(token: string): Promise<string | null> {
  await ensureUserProfileTable()
  const t = token.trim()
  if (!t) return null
  if (t.includes('@') && t.includes('.') && !t.startsWith('@')) {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM "user" WHERE lower(email) = lower($1)', [t])
    if (rows[0]) return rows[0].id
  }
  const handle = t.replace(/^@/, '').toLowerCase()
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM user_profile
      WHERE lower(substring(tiktok_url from '@([^/?#]+)')) = $1 OR user_id = $2 LIMIT 2`,
    [handle, t]
  )
  return rows.length === 1 ? rows[0].user_id : null
}

/**
 * Add removals from free text: one per line, each line naming a worker
 * (@handle, email or user id) and a link — in any order, so the CSV the
 * "null" scan writes can be pasted as it is. Lines with no link are skipped
 * (a CSV header); lines whose worker cannot be found are reported back.
 */
export async function addRemovalsFromText(
  text: string,
  matchText: string | null
): Promise<{ added: number; skipped: string[] }> {
  await ensureTable()
  const match = matchText && matchText.trim() ? matchText.trim() : null
  const skipped: string[] = []
  const rows: { userId: string; url: string; handle: string | null }[] = []
  const cache = new Map<string, string | null>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const url = line.match(/https?:\/\/[^\s",]+/)?.[0]
    if (!url) continue
    // The worker: an @handle first, then an email, then any other word.
    const rest = line.replace(url, ' ').replace(/"/g, ' ')
    const tokens = rest.split(/[\s,;\t]+/).filter(Boolean)
    const candidates = [
      ...tokens.filter((t) => t.startsWith('@')),
      ...tokens.filter((t) => /\S+@\S+\.\S+/.test(t) && !t.startsWith('@')),
      ...tokens.filter((t) => !t.startsWith('@') && !t.includes('@')),
    ]
    let userId: string | null = null
    for (const c of candidates) {
      if (!cache.has(c)) cache.set(c, await resolveWho(c).catch(() => null))
      userId = cache.get(c) ?? null
      if (userId) break
    }
    if (!userId) {
      skipped.push(line.length > 120 ? line.slice(0, 117) + '…' : line)
      continue
    }
    // One row per worker + link, however many times the pair is listed.
    // The @username on the line is the account that posted the comment.
    const at = tokens.find((t) => /^@[A-Za-z0-9._]+$/.test(t))
    const handle = at ? at.slice(1).toLowerCase() : null
    if (!rows.some((r) => r.userId === userId && r.url === url)) rows.push({ userId, url, handle })
  }
  if (rows.length === 0) return { added: 0, skipped }
  // Re-adding a link that was already cleaned puts it back to do again.
  const { rowCount } = await pool.query(
    `INSERT INTO comment_removal (user_id, url, match_text, handle)
     SELECT u, l, $3, h FROM unnest($1::text[], $2::text[], $4::text[]) AS x(u, l, h)
     ON CONFLICT (user_id, url) DO UPDATE SET
       match_text = EXCLUDED.match_text, created_at = now(),
       handle = COALESCE(EXCLUDED.handle, comment_removal.handle),
       done_at = NULL, done_how = NULL, checked_at = NULL, still_text = NULL`,
    [rows.map((r) => r.userId), rows.map((r) => r.url), match, rows.map((r) => r.handle)]
  )
  return { added: rowCount ?? rows.length, skipped }
}

export interface RemovalRow {
  id: number
  userId: string
  name: string
  handle: string | null
  url: string
  matchText: string | null
  createdAt: string
  doneAt: string | null
  doneHow: string | null
  checkedAt: string | null
  stillText: string | null
}

/** Everything, newest first — the admin page. */
export async function listRemovals(): Promise<RemovalRow[]> {
  await Promise.all([ensureTable(), ensureUserProfileTable()])
  const { rows } = await pool.query<{
    id: string; user_id: string; name: string | null; auth_name: string | null; tiktok_url: string | null
    url: string; match_text: string | null; created_at: Date; done_at: Date | null; done_how: string | null
    checked_at: Date | null; still_text: string | null
  }>(
    `SELECT r.*, p.name, u.name AS auth_name, p.tiktok_url
       FROM comment_removal r
       LEFT JOIN user_profile p ON p.user_id = r.user_id
       LEFT JOIN "user" u ON u.id = r.user_id
      ORDER BY (r.done_at IS NULL) DESC, r.created_at DESC, r.id DESC
      LIMIT 5000`
  )
  return rows.map((r) => ({
    id: Number(r.id),
    userId: r.user_id,
    name: r.name || r.auth_name || r.user_id.slice(0, 8),
    handle: handleFromProfile(r.tiktok_url ?? ''),
    url: r.url,
    matchText: r.match_text,
    createdAt: r.created_at.toISOString(),
    doneAt: r.done_at?.toISOString() ?? null,
    doneHow: r.done_how,
    checkedAt: r.checked_at?.toISOString() ?? null,
    stillText: r.still_text,
  }))
}

export async function deleteRemovals(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0
  await ensureTable()
  const { rowCount } = await pool.query('DELETE FROM comment_removal WHERE id = ANY($1::bigint[])', [ids])
  return rowCount ?? 0
}

export async function markRemovalsDone(ids: number[], how = 'admin'): Promise<void> {
  if (ids.length === 0) return
  await ensureTable()
  await pool.query(
    `UPDATE comment_removal SET done_at = now(), done_how = $2 WHERE id = ANY($1::bigint[]) AND done_at IS NULL`,
    [ids, how]
  )
}

export interface RemovalCheck {
  done: boolean
  /** True when the video was read and their comment is not on it. */
  verified: boolean
  /** The comment still found, when it is still there. */
  stillText: string | null
  /** How many links they still have to clean up. */
  remaining: number
  /** When not done and nothing was found: why it could not be confirmed (shown in the app). */
  message?: string
}

/** How deep a TikTok read goes looking for their comment: 50 top-level comments a page. */
const TIKTOK_PAGES = 40

type Look =
  | { state: 'found'; text: string }
  | { state: 'gone' }
  | { state: 'unknown'; why: string }

/** The TikTok usernames a removal row is checked against: the one listed, and the one on their profile. */
async function tiktokNames(userId: string, listed: string | null): Promise<string[]> {
  const { rows: p } = await pool.query<{ tiktok_url: string | null }>(
    'SELECT tiktok_url FROM user_profile WHERE user_id = $1', [userId])
  const names = new Set<string>()
  if (listed) names.add(listed.toLowerCase().replace(/^@/, ''))
  const fromProfile = handleFromProfile(p[0]?.tiktok_url ?? '')
  if (fromProfile) names.add(fromProfile.toLowerCase())
  return Array.from(names)
}

/**
 * Is their comment on this video? Read by their TikTok USERNAME.
 *
 * GONE only when TikTok said there were no more comments to read and none of
 * them was theirs. A read that stopped early — a throttled reply, an error, a
 * video deeper than TIKTOK_PAGES — proves nothing, so it is 'unknown' and the
 * link stays on their list.
 */
async function lookOnVideo(
  userId: string,
  row: { url: string; match_text: string | null; handle: string | null }
): Promise<Look> {
  const match = row.match_text ? commentKey(row.match_text) : null
  const theirs = (text: string) => (match === null ? true : commentKey(text) === match)
  const platform = platformOfUrl(row.url)

  if (platform === 'tiktok') {
    const names = await tiktokNames(userId, row.handle)
    if (names.length === 0) return { state: 'unknown', why: 'No TikTok username on your profile — ask the admin' }
    const r = await fetchComments(row.url, TIKTOK_PAGES, 8000).catch(() => null)
    if (!r) return { state: 'unknown', why: "Couldn't read the video's comments — try again in a minute" }
    const hit = r.comments.find((c) => names.includes(c.username) && theirs(c.text))
    if (hit) return { state: 'found', text: hit.text }
    // A link that is not a video any more has no comments on it.
    if (r.unresolved || r.exhausted) return { state: 'gone' }
    return { state: 'unknown', why: "Couldn't read all the comments on this video yet — try again in a minute" }
  }

  if ((platform === 'youtube' && youtubeEnabled()) || (platform === 'reddit' && redditEnabled())) {
    const [{ rows: p }, known] = await Promise.all([
      pool.query<{ youtube_url: string | null }>('SELECT youtube_url FROM user_profile WHERE user_id = $1', [userId]),
      getPlatformAccounts(userId).catch(() => ({} as Record<string, string>)),
    ])
    const mine = new Set(
      [platform === 'youtube' ? youtubeIdentity(p[0]?.youtube_url).handle : null, known[platform]].filter(Boolean) as string[]
    )
    if (mine.size > 0) {
      const r = platform === 'youtube'
        ? await fetchYoutubeComments(row.url).catch(() => null)
        : await fetchRedditComments(row.url).catch(() => null)
      if (r && !r.unresolved) {
        const hit = r.comments.find((c) => mine.has(c.author) && theirs(c.text))
        if (hit) return { state: 'found', text: hit.text }
        if (r.complete) return { state: 'gone' }
      }
    }
  }
  // Platforms we cannot read (Instagram, or no key): their word.
  return { state: 'gone' }
}

/** Write what a look found onto the row. Returns true when it is now done. */
async function record(id: number, look: Look, verifiedRead: boolean): Promise<boolean> {
  if (look.state === 'found') {
    // Still (or again) there: on their list, whatever was said before.
    await pool.query(
      `UPDATE comment_removal SET checked_at = now(), still_text = $2, done_at = NULL, done_how = NULL
        WHERE id = $1`,
      [id, look.text]
    )
    return false
  }
  if (look.state === 'gone') {
    await pool.query(
      `UPDATE comment_removal SET done_at = COALESCE(done_at, now()), done_how = $2, checked_at = now(), still_text = NULL
        WHERE id = $1`,
      [id, verifiedRead ? 'verified' : 'worker']
    )
    return true
  }
  return false
}

/**
 * The worker says they removed it: read the video by their TikTok username.
 *
 * STILL THERE → not done, and the comment found is returned so they know which.
 * GONE        → done, 'verified' (TikTok, or a full YouTube/Reddit read).
 * UNSURE      → not done; `message` says why, and they try again.
 */
export async function checkRemoval(userId: string, id: number): Promise<RemovalCheck | null> {
  await ensureTable()
  const { rows } = await pool.query<{ url: string; match_text: string | null; handle: string | null; done_at: Date | null }>(
    'SELECT url, match_text, handle, done_at FROM comment_removal WHERE id = $1 AND user_id = $2',
    [id, userId]
  )
  const row = rows[0]
  if (!row) return null
  const remainingNow = async () => (await pendingRemovals(userId)).length
  if (row.done_at) return { done: true, verified: true, stillText: null, remaining: await remainingNow() }

  const look = await lookOnVideo(userId, row)
  const readable = platformOfUrl(row.url) === 'tiktok' ||
    (platformOfUrl(row.url) === 'youtube' && youtubeEnabled()) ||
    (platformOfUrl(row.url) === 'reddit' && redditEnabled())
  const done = await record(id, look, readable)
  return {
    done,
    verified: done && readable,
    stillText: look.state === 'found' ? look.text : null,
    remaining: await remainingNow(),
    ...(look.state === 'unknown' ? { message: look.why } : {}),
  }
}

export interface SweepResult {
  checked: number
  stillThere: number
  gone: number
  unknown: number
  /** Rows the worker had ticked off whose comment turned out to be still there. */
  reopened: number
}

/**
 * Check every TikTok removal on the server, without waiting for the worker:
 * links where their comment is not on the video are crossed off, links where it
 * is are marked "still there" — including ones crossed off earlier on the
 * worker's word, which go back on their list.
 */
export async function sweepRemovals(
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<SweepResult> {
  await ensureTable()
  const { rows } = await pool.query<{
    id: string; user_id: string; url: string; match_text: string | null; handle: string | null; done_how: string | null
  }>(
    `SELECT id, user_id, url, match_text, handle, done_how FROM comment_removal
      WHERE (done_at IS NULL OR done_how = 'worker') AND url ILIKE '%tiktok.com%'
      ORDER BY id`
  )
  const out: SweepResult = { checked: 0, stillThere: 0, gone: 0, unknown: 0, reopened: 0 }
  let next = 0
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++]
      const look = await lookOnVideo(r.user_id, r).catch((): Look => ({ state: 'unknown', why: 'error' }))
      await record(Number(r.id), look, true)
      out.checked++
      if (look.state === 'found') { out.stillThere++; if (r.done_how === 'worker') out.reopened++ }
      else if (look.state === 'gone') out.gone++
      else out.unknown++
      opts.onProgress?.(out.checked, rows.length)
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker))
  return out
}
