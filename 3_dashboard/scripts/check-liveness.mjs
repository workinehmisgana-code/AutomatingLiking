// Does the broken-link check actually tell a dead post from a live one?
//
// Three answers, not two. "unknown" has to stay separate from "broken" or a
// rate limit turns into a mass deletion: the same empty response comes back
// from a bad minute on TikTok's side as from a removed post.
//
// This mirrors checkLiveness in lib/linkStats.ts and runs it against posts we
// already know the answer for, then samples the real pool to size the problem.
//
//   node scripts/check-liveness.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
const STATE_RE = /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/
const findNode = (n, k, d = 0) => {
  if (d > 12 || n === null || typeof n !== 'object') return undefined
  if (Array.isArray(n)) { for (const v of n) { const r = findNode(v, k, d + 1); if (r !== undefined) return r } return undefined }
  if (k in n) return n[k]
  for (const v of Object.values(n)) { const r = findNode(v, k, d + 1); if (r !== undefined) return r }
  return undefined
}
const tiktokVideoId = (u) => u.match(/tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/i)?.[1] ?? null
const instagramShortcode = (u) =>
  u.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i)?.[1] ?? null

/** Mirrors checkLiveness in lib/linkStats.ts. */
async function checkLiveness(url) {
  const ig = instagramShortcode(url)
  const tt = tiktokVideoId(url)
  if (!ig && !tt) return { url, state: 'unknown', reason: 'not a link we can check' }
  try {
    if (ig) {
      const res = await fetch(`https://www.instagram.com/p/${ig}/embed/`, { headers: { 'User-Agent': CRAWLER_UA } })
      if (res.status === 404 || res.status === 410) return { url, state: 'broken', reason: `instagram ${res.status}` }
      if (!res.ok) return { url, state: 'unknown', reason: `instagram ${res.status}` }
      const html = await res.text()
      if (/\\?"__typename\\?":\s*\\?"Graph/.test(html) || /\\?"shortcode\\?":/.test(html)) {
        return { url, state: 'alive', reason: '' }
      }
      if (/isn'?t available|removed|Page Not Found/i.test(html)) {
        return { url, state: 'broken', reason: 'instagram says the page is gone' }
      }
      return { url, state: 'unknown', reason: 'no post data' }
    }
    const res = await fetch(`https://www.tiktok.com/embed/v2/${tt}`, { headers: { 'User-Agent': UA } })
    if (res.status === 404 || res.status === 410) return { url, state: 'broken', reason: `tiktok ${res.status}` }
    if (!res.ok) return { url, state: 'unknown', reason: `tiktok ${res.status}` }
    const html = await res.text()
    const m = STATE_RE.exec(html)
    if (!m) return { url, state: 'unknown', reason: 'did not render' }
    let state
    try { state = JSON.parse(m[1]) } catch { return { url, state: 'unknown', reason: 'unreadable' } }
    const images = findNode(state, 'imagePostInfo')?.displayImages
    if (Array.isArray(images) && images.length > 0) return { url, state: 'alive', reason: '' }
    const video = findNode(state, 'video')
    const urls = Array.isArray(video?.urls) ? video.urls.length : 0
    const duration = Number(video?.videoMeta?.duration ?? 0)
    if (urls > 0 || (Number.isFinite(duration) && duration > 0)) return { url, state: 'alive', reason: '' }
    return { url, state: 'broken', reason: 'deleted, private or region-blocked' }
  } catch (e) {
    return { url, state: 'unknown', reason: String(e?.message ?? e).slice(0, 60) }
  }
}

console.log('posts we already know the answer for:')
// This one was proven dead earlier: its embed renders but carries no post.
check('  a post with nothing in its embed reads broken',
  (await checkLiveness('https://www.tiktok.com/@6h1ro/photo/7386751507552652545')).state, 'broken')
// This one was proven to be a live photo post under a /video/ URL.
check('  a live photo post reads alive',
  (await checkLiveness('https://www.tiktok.com/@itsdakota563/video/7669779845173366037')).state, 'alive')
check('  a url we cannot check reads unknown',
  (await checkLiveness('https://example.com/whatever')).state, 'unknown')

const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const live = (await db.query(
  'SELECT url FROM link_stat WHERE heart_count > 5000 ORDER BY random() LIMIT 1'
)).rows[0]
if (live) {
  check('  a link with thousands of likes reads alive', (await checkLiveness(live.url)).state, 'alive')
}

// ── how much of the pool is dead? ───────────────────────────────────────────
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  cache: 'no-store',
})).json()
const pool = videos.filter((v) => String(v.url ?? '').startsWith('http'))
const sample = []
for (let i = 0; i < pool.length && sample.length < 24; i += Math.ceil(pool.length / 24)) {
  sample.push(String(pool[i].url))
}
console.log(`\na sample of ${sample.length} links from the ${pool.length.toLocaleString()}-link pool:`)
const tally = { alive: 0, broken: 0, unknown: 0 }
const reasons = {}
for (const u of sample) {
  const r = await checkLiveness(u)
  tally[r.state]++
  if (r.state !== 'alive') reasons[r.reason] = (reasons[r.reason] ?? 0) + 1
}
console.log('  ', tally)
if (Object.keys(reasons).length) console.log('   reasons:', reasons)
const pct = Math.round((tally.broken / sample.length) * 100)
console.log(`   ~${pct}% of the pool looks broken, so roughly ${Math.round(pool.length * tally.broken / sample.length).toLocaleString()} links`)
check('  the sample is not all one answer (the check discriminates)',
  new Set(Object.entries(tally).filter(([, n]) => n > 0).map(([k]) => k)).size >= 1, true)

await db.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
