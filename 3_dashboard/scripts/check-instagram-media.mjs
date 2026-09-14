// Is an Instagram link a photo or a video?
//
// Its URL cannot say. /p/ is the generic permalink and serves single images,
// carousels AND reels; only /reel/ is video-specific, and a reel is reachable at
// /p/<code>/ too. Every Instagram link in this pool is a /p/ link, so reading
// the path classified all of them as photos — including 45-second reels.
//
// This mirrors fetchInstagramStat against live posts and against the pool.
//
//   node scripts/check-instagram-media.mjs
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

const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const BS = '\\\\?'
const shortcode = (u) =>
  u.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i)?.[1] ?? null

/** Mirrors fetchInstagramStat in lib/linkStats.ts. */
async function read(url, ua = CRAWLER_UA) {
  const code = shortcode(url)
  if (!code) return { isPhoto: null, hearts: null, views: null, typename: null }
  const res = await fetch(`https://www.instagram.com/p/${code}/embed/`, {
    headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' },
  })
  if (!res.ok) return { isPhoto: null, hearts: null, views: null, typename: null }
  const html = await res.text()
  const num = (key) => {
    const m = html.match(new RegExp(`${BS}"${key}${BS}":\\s*(\\d+)`))
    const n = m ? Number(m[1]) : NaN
    return Number.isFinite(n) ? n : null
  }
  const typename =
    html.match(new RegExp(`${BS}"__typename${BS}":\\s*${BS}"(Graph[A-Za-z]+)`))?.[1] ?? null
  const videoRe = (v) => new RegExp(`${BS}"is_video${BS}":\\s*${v}`).test(html)
  const isVideoFlag = videoRe('true') ? true : videoRe('false') ? false : null
  let isPhoto = null
  if (typename === 'GraphVideo') isPhoto = false
  else if (typename === 'GraphImage' || typename === 'GraphSidecar') isPhoto = true
  else if (isVideoFlag !== null) isPhoto = !isVideoFlag
  return { isPhoto, hearts: num('count'), views: num('video_view_count'), typename }
}

console.log('the post that started this:')
const one = 'https://www.instagram.com/p/DcsXeYopYU5/'
const got = await read(one)
console.log(`   ${one}`)
console.log(`   typename ${got.typename} · likes ${got.hearts} · views ${got.views}`)
check('  a /p/ URL that is really a reel reads as a VIDEO', got.isPhoto, false)

console.log('\nthe crawler User-Agent is required:')
const asBrowser = await read(one, BROWSER_UA)
console.log(`   as a browser: typename ${asBrowser.typename}, isPhoto ${asBrowser.isPhoto}`)
console.log('   (Instagram strips the media data for a browser UA — hence facebookexternalhit)')

// ── a sample of the pool, to see what the /p/ guess was costing ─────────────
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  cache: 'no-store',
})).json()
const ig = videos.filter((v) => String(v.platform) === 'instagram')
console.log(`\nthe pool holds ${ig.length.toLocaleString()} instagram link(s), all /p/:`)

const sample = []
for (let i = 0; i < ig.length && sample.length < 12; i += Math.ceil(ig.length / 12)) sample.push(ig[i])
let video = 0
let photo = 0
let unknown = 0
for (const v of sample) {
  const r = await read(String(v.url))
  if (r.isPhoto === false) video++
  else if (r.isPhoto === true) photo++
  else unknown++
  console.log(
    `   ${(r.isPhoto === null ? 'unknown' : r.isPhoto ? 'photo' : 'VIDEO').padEnd(8)}` +
      `${String(r.typename ?? '-').padEnd(13)} likes ${String(r.hearts ?? '-').padEnd(7)} ${String(v.url).slice(-14)}`
  )
}
console.log(`   of ${sample.length} sampled: ${video} video(s), ${photo} photo(s), ${unknown} unreadable`)
check('  at least one is a video the old rule called a photo', video > 0, true)
console.log(`   every one of the ${ig.length.toLocaleString()} was scored as a photo before this fix`)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
