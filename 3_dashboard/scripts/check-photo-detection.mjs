// Is a TikTok link a photo post or a video?
//
// Three things had to be true and were not:
//
//   1. Both answers need EVIDENCE. A deleted or private post's embed still
//      returns HTTP 200 with the full page shape — imagePostInfo null, video
//      {urls: [], duration: 0}, all counts zero. That used to read as "a
//      videoData block and no images, therefore a video".
//   2. ONE rule. The admin table let the URL win, the scoring let the stored
//      flag win, so a link could be a photo in the table and a video in its score.
//   3. Unknown is not "video". 73% of the pool has never been checked.
//
// This checks the rule against fixed cases, then fetches live embeds to confirm
// the reading of a real photo, a real video and a dead post.
//
//   node scripts/check-photo-detection.mjs
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

/** Mirrors isPhotoLink in lib/dateScore.ts. */
const isPhotoLink = (url, isPhoto) => {
  if (/tiktok\.com\/@[^/]+\/photo\//i.test(url)) return true
  if (isPhoto === true) return true
  if (isPhoto === false) return false
  if (/tiktok\.com\/@[^/]+\/video\//i.test(url)) return null
  if (/instagram\.com\/(?:reel|tv)\//i.test(url)) return false
  if (/instagram\.com\/(?:[^/]+\/)?p\//i.test(url)) return null
  if (/youtube\.com|youtu\.be/i.test(url)) return false
  return null
}
const photoScore = (url, isPhoto) => {
  const p = isPhotoLink(url, isPhoto)
  return p === null ? 0.5 : p ? 0 : 1
}

const TT = 'https://www.tiktok.com/@someone'
console.log('the rule:')
check('  /photo/ URL is a photo whatever the flag says', isPhotoLink(`${TT}/photo/1`, false), true)
check('  /video/ URL with flag=true is a photo', isPhotoLink(`${TT}/video/1`, true), true)
check('  /video/ URL with flag=false is a video', isPhotoLink(`${TT}/video/1`, false), false)
check('  /video/ URL with NO flag is UNKNOWN, not a video', isPhotoLink(`${TT}/video/1`, null), null)
// /p/ serves images, carousels and reels alike — the path cannot decide.
check('  instagram /p/ is UNKNOWN, not a photo', isPhotoLink('https://www.instagram.com/p/abc/', null), null)
check('  instagram /p/ with flag=false is a video', isPhotoLink('https://www.instagram.com/p/abc/', false), false)
check('  instagram /reel/ is a video', isPhotoLink('https://www.instagram.com/reel/abc/', null), false)
check('  youtube is a video', isPhotoLink('https://www.youtube.com/watch?v=a', null), false)

console.log('\nwhat the score does with each:')
check('  a known video scores 1', photoScore(`${TT}/video/1`, false), 1)
check('  a known photo scores 0', photoScore(`${TT}/video/1`, true), 0)
check('  an unchecked link scores NEUTRAL', photoScore(`${TT}/video/1`, null), 0.5)

// ── the live embed, which is where the evidence comes from ──────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const STATE_RE = /<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/
const findNode = (n, k, d = 0) => {
  if (d > 12 || n === null || typeof n !== 'object') return undefined
  if (Array.isArray(n)) { for (const v of n) { const r = findNode(v, k, d + 1); if (r !== undefined) return r } return undefined }
  if (k in n) return n[k]
  for (const v of Object.values(n)) { const r = findNode(v, k, d + 1); if (r !== undefined) return r }
  return undefined
}
/** Mirrors isPhotoPost in lib/linkStats.ts. */
const readEmbed = (state) => {
  const images = findNode(state, 'imagePostInfo')?.displayImages
  if (Array.isArray(images) && images.length > 0) return true
  const video = findNode(state, 'video')
  const urls = Array.isArray(video?.urls) ? video.urls.length : 0
  const duration = Number(video?.videoMeta?.duration ?? 0)
  if (urls > 0 || (Number.isFinite(duration) && duration > 0)) return false
  return null
}

console.log('\nreading real embeds:')
const cases = [
  ['a photo post served under a /video/ URL', 'https://www.tiktok.com/@itsdakota563/video/7669779845173366037', true],
  ['a dead post — no data in the embed at all', 'https://www.tiktok.com/@6h1ro/photo/7386751507552652545', null],
]
// One live video from the pool, whichever still works.
const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const live = (await db.query(
  `SELECT url FROM link_stat WHERE is_photo = false AND heart_count > 1000 ORDER BY random() LIMIT 1`
)).rows[0]
await db.end()
if (live) cases.push(['a real video with likes', live.url, false])

for (const [label, url, want] of cases) {
  const id = url.match(/\/(?:video|photo)\/(\d+)/)?.[1]
  try {
    const res = await fetch(`https://www.tiktok.com/embed/v2/${id}`, { headers: { 'User-Agent': UA } })
    const m = STATE_RE.exec(await res.text())
    if (!m) { console.log(`   ??   ${label}: no state block (cannot judge)`); continue }
    check(`  ${label}`, readEmbed(JSON.parse(m[1])), want)
  } catch (e) {
    console.log(`   ??   ${label}: fetch failed (${String(e).slice(0, 40)})`)
  }
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
