import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { saveLinkTitles } from '@/lib/db'
import { isGenericTitle, stripPlatformSuffix } from '@/lib/titleFilter'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// A social-media crawler UA: Instagram (and others) serve the caption via og:title
// to link-preview bots, but show a login wall to a normal browser UA.
const UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'

async function fetchWithTimeout(url: string, init?: RequestInit, ms = 8000): Promise<Response | null> {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: c.signal, cache: 'no-store' })
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

function decodeEntities(s: string): string {
  const cp = (n: number) => {
    try { return String.fromCodePoint(n) } catch { return '' }
  }
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

// Read one <meta> tag's content, in either attribute order.
//
// Double- and single-quoted values are matched as SEPARATE alternatives, so a
// value ends only at its own kind of quote. The previous
// `content=["']([^"']+)["']` stopped at the first quote of EITHER kind, which
// truncated every title containing an apostrophe: `content="Here's the best
// humanizer"` captured just `Here`, and `"Don't use AI detectors, it's over"`
// just `Don`. Apostrophes are extremely common in captions, so most titles came
// back cut off at the first one.
const META_VALUE = `(?:"([^"]*)"|'([^']*)')`

const metaContent = (html: string, prop: string): string | null => {
  const m =
    html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*?content=${META_VALUE}`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=${META_VALUE}[^>]*?property=["']${prop}["']`, 'i'))
  const v = m?.[1] ?? m?.[2]
  return v ? decodeEntities(v) : null
}

// Instagram no longer exposes the caption via og:title/og:description meta tags —
// it's now embedded deep in the page JSON as "caption":{"text":"…"} (~500KB in).
// Pull the first non-empty caption (the main post's) and JSON-unescape it.
function captionFromJson(html: string): string | null {
  const m = html.match(/"caption":\{"text":"((?:[^"\\]|\\.)*)"/)
  if (!m?.[1]) return null
  let t = m[1]
  try {
    t = JSON.parse(`"${t}"`)
  } catch {
    t = t.replace(/\\n/g, ' ').replace(/\\"/g, '"')
  }
  t = t.replace(/\s+/g, ' ').trim()
  return t || null
}

// Pull a title from a page's HTML: prefer og:title, then og:description, then the
// embedded caption JSON (Instagram), then <title>. Uses the crawler UA. Any
// candidate that is a login-wall / generic placeholder is skipped. We read up to
// 1MB because Instagram's caption lives ~500KB into the page.
async function ogTitle(url: string): Promise<string | null> {
  const isIg = /instagram\.com/.test(url)
  const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } })
  if (!r || !r.ok) {
    if (isIg) console.log(`[titles] IG fetch failed ${url} status=${r?.status ?? 'no-response'}`)
    return null
  }
  const html = (await r.text()).slice(0, 1_000_000)
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const candidates = [
    metaContent(html, 'og:title'),
    metaContent(html, 'og:description'),
    captionFromJson(html),
    t?.[1] ? decodeEntities(t[1]) : null,
  ]
  for (const c of candidates) {
    // Drop the "- YouTube" / "| TikTok" tail the <title> fallback carries, then
    // reject anything that was only that tail.
    const clean = c ? stripPlatformSuffix(c) : null
    if (clean && !isGenericTitle(clean)) return clean
  }
  if (isIg) {
    console.log(
      `[titles] IG no usable title ${url} bytes=${html.length} ` +
        `ogt=${candidates[0] ? JSON.stringify(candidates[0].slice(0, 40)) : 'null'} ` +
        `cap=${candidates[2] ? JSON.stringify(candidates[2].slice(0, 40)) : 'null'} ` +
        `title=${candidates[3] ? JSON.stringify(candidates[3].slice(0, 30)) : 'null'}`
    )
  }
  return null
}

async function oembedTitle(endpoint: string): Promise<string | null> {
  const r = await fetchWithTimeout(endpoint, { headers: { 'User-Agent': UA } })
  if (!r || !r.ok) return null
  try {
    const j = (await r.json()) as { title?: string }
    return j?.title ? decodeEntities(j.title) : null
  } catch {
    return null
  }
}

// Best-effort title for a single video link, by platform.
async function titleFor(url: string, platform: string): Promise<string | null> {
  try {
    if (platform.startsWith('youtube') || /youtu\.?be/.test(url)) {
      const t = await oembedTitle(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
      if (t) return t
    }
    if (platform === 'tiktok' || /tiktok\.com/.test(url)) {
      // oEmbed only accepts /video/ URLs; photo (slideshow) posts share the id.
      const tkUrl = url.replace('/photo/', '/video/')
      const t = await oembedTitle(`https://www.tiktok.com/oembed?url=${encodeURIComponent(tkUrl)}`)
      if (t) return t
    }
    // Instagram (and any fallback): read og:title from the page HTML.
    return await ogTitle(url)
  } catch {
    return null
  }
}

// Run tasks with a small concurrency cap.
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

// POST { items: [{ url, platform }] } — fetch each video's title from its platform.
// Returns { titles: { [url]: string } } (only the ones that resolved).
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let items: { url: string; platform: string }[] = []
  try {
    const b = await req.json()
    if (Array.isArray(b?.items)) {
      items = b.items
        .map((it: unknown) => {
          const o = it as { url?: unknown; platform?: unknown }
          return { url: String(o?.url ?? '').trim(), platform: String(o?.platform ?? '').trim() }
        })
        .filter((it: { url: string }) => it.url.startsWith('http'))
        .slice(0, 60) // cap per request to stay within the function budget
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (items.length === 0) return NextResponse.json({ titles: {} })

  const results = await pool(items, 8, async (it) => ({ url: it.url, platform: it.platform, title: await titleFor(it.url, it.platform) }))
  const titles: Record<string, string> = {}
  for (const r of results) if (r.title) titles[r.url] = r.title
  // Temporary diagnostic: per-platform resolved/total for this request.
  const byPlat: Record<string, { ok: number; total: number }> = {}
  for (const r of results) {
    const p = r.platform || 'unknown'
    byPlat[p] = byPlat[p] || { ok: 0, total: 0 }
    byPlat[p].total++
    if (r.title) byPlat[p].ok++
  }
  console.log('[titles] request resolved:', JSON.stringify(byPlat))
  await saveLinkTitles(titles).catch(() => {}) // cache so we never re-fetch these
  return NextResponse.json({ titles })
}
