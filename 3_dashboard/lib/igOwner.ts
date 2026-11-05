// Who posted an Instagram link.
//
// TikTok and YouTube put the handle in the video URL. Instagram does not — a
// post is /p/<code>/ or /reel/<code>/ and names nobody — so a blocked
// Instagram link used to be untraceable: blocking removes it from the pool, and
// blocked_link kept only the URL. Every Instagram channel then read "—" in the
// Active % column, because its blocked count was unknowable.
//
// blocked_link.account now records the owner at block time. This file is the
// one place that knows how to find it:
//
//   1. the URL itself, for the rarer /<handle>/p/<code>/ form
//   2. the post's own embed page, which names the owner in its profile link
//      and again in its username element (the same route
//      scripts/backfill-instagram-authors.mjs measured at 14/14 live posts)
//
// Callers try what they already hold first (the staged row's account, the pool
// row's author) and only fall back to the network for what is left.
//
// Kept free of imports so the backfill scripts can mirror it exactly.

/** Bare, lowercased handle, or null when the value names nobody. */
export function normHandle(v: unknown): string | null {
  const h = String(v ?? '').trim().replace(/^@/, '').toLowerCase()
  return /^[a-z0-9._]{1,30}$/.test(h) ? h : null
}

export function isInstagramUrl(url: string): boolean {
  return /instagram\.com\//i.test(String(url || ''))
}

/** The owner when the URL is the /<handle>/p/<code>/ form, else null. */
export function instagramHandleFromUrl(url: string): string | null {
  const m = String(url || '').match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel|tv)\//i)
  const h = m?.[1]?.toLowerCase()
  return h && !NOT_A_HANDLE.has(h) ? normHandle(h) : null
}

const SHORTCODE = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
// Two independent signals; either is enough.
const OWNER_PATTERNS = [
  /instagram\.com\/([A-Za-z0-9._]{1,30})\/\?utm/,
  /class="[^"]*UsernameText[^"]*"[^>]*>([A-Za-z0-9._]{1,30})</,
]
// Handles the embed chrome uses for its own links, never a real owner.
const NOT_A_HANDLE = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'about', 'developer', 'stories'])

export function ownerFromEmbedHtml(html: string): string | null {
  for (const re of OWNER_PATTERNS) {
    const h = re.exec(html)?.[1]?.toLowerCase()
    if (h && !NOT_A_HANDLE.has(h)) return normHandle(h)
  }
  return null
}

export type OwnerLookup =
  | { state: 'ok'; owner: string }
  | { state: 'gone' | 'unparsed' | 'no-code' | 'http' | 'error'; detail?: string }

/**
 * Read the owner from the post's embed page. One request, ~1 s.
 *
 * 'gone' is the fixed-size shell a deleted or private post serves: no owner and
 * no media id. Nothing can name the owner of those, from anywhere.
 */
export async function lookupInstagramOwner(url: string, timeoutMs = 6000): Promise<OwnerLookup> {
  const fromUrl = instagramHandleFromUrl(url)
  if (fromUrl) return { state: 'ok', owner: fromUrl }
  const code = SHORTCODE.exec(String(url || ''))?.[1]
  if (!code) return { state: 'no-code' }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://www.instagram.com/p/${code}/embed/`, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1' },
      signal: ctl.signal,
      cache: 'no-store',
    })
    if (!res.ok) return { state: 'http', detail: String(res.status) }
    const html = await res.text()
    const owner = ownerFromEmbedHtml(html)
    if (owner) return { state: 'ok', owner }
    return { state: /"media_id"\s*:\s*"?\d/.test(html) ? 'unparsed' : 'gone' }
  } catch (e) {
    return { state: 'error', detail: String(e).slice(0, 80) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Owners for many URLs, a few at a time, stopping at a deadline.
 *
 * Bounded on purpose: this runs inside a block request, and a bulk block of a
 * thousand Instagram links must not hold the request open for twenty minutes.
 * Whatever the deadline leaves unresolved stays NULL and is picked up by
 * scripts/backfill-blocked-instagram-owners.mjs.
 */
export async function lookupInstagramOwners(
  urls: string[],
  { concurrency = 6, deadlineMs = 10_000, max = 60 } = {}
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const todo = urls.slice(0, max)
  const stopAt = Date.now() + deadlineMs
  let next = 0
  const worker = async () => {
    for (;;) {
      if (Date.now() >= stopAt) return
      const i = next++
      if (i >= todo.length) return
      const left = Math.max(1000, stopAt - Date.now())
      const r = await lookupInstagramOwner(todo[i], Math.min(6000, left))
      if (r.state === 'ok') out.set(todo[i], r.owner)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
  return out
}
