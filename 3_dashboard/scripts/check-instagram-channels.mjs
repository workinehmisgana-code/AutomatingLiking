// The three channel tools on "Links to verify", and Instagram.
//
//   📋 Review channels   lists the staged channels and opens each one
//   📊 Rank channels     orders every channel we hold, from data we already have
//   ⬇ Extract new videos asks each channel what it has posted since
//
// The first two work for Instagram and are checked here against the live pool.
// The third CANNOT, and that is an external fact rather than a gap in the code:
// Instagram has no unauthenticated route to a profile's posts. Measured
// 2026-09-15, against real handles from the pool:
//
//   /api/v1/users/web_profile_info/   HTTP 429, empty body
//   /<handle>/?__a=1&__d=dis          HTTP 400
//   /<handle>/ as a browser           HTTP 200, 626 KB of JS shell, no post codes
//   /<handle>/ as facebookexternalhit HTTP 200, 727 KB, no post codes
//
// A single POST is readable (/p/<code>/embed/), which is why link stats and the
// broken-link sweep work for Instagram: reading a post you already know about
// is a different question from asking what a profile has posted.
//
// So what this checks for extraction is that it says so — that Instagram
// channels are skipped deliberately and counted, rather than fetched, failing,
// and reported as dead channels.
//
//   node scripts/check-instagram-channels.mjs
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
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

// lib/channelRank.ts, as it resolves a channel and its site.
const handleOf = (url) => {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
  if (tt) return tt[1].toLowerCase()
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return yt[1].toLowerCase()
  return null
}
const channelOfRow = (url, author) =>
  handleOf(url) ?? (String(author ?? '').trim().replace(/^@/, '').toLowerCase() || null)
const siteOf = (u) => {
  const s = u.toLowerCase()
  if (s.includes('instagram.com')) return 'instagram'
  if (s.includes('youtube.com') || s.includes('youtu.be')) return 'youtube'
  return 'tiktok'
}

// components/VerifyLinks.tsx channelUrl — what "open this channel" goes to.
const channelUrl = (account, platform) => {
  const a = (account || '').trim().replace(/^@/, '')
  if (!a) return null
  const p = (platform || 'tiktok').toLowerCase()
  if (p.startsWith('youtube')) return `https://www.youtube.com/@${encodeURIComponent(a)}`
  if (p === 'instagram') return `https://www.instagram.com/${encodeURIComponent(a)}/`
  return `https://www.tiktok.com/@${encodeURIComponent(a)}`
}

console.log('Review channels opens an Instagram profile at its real address:')
check('  instagram', channelUrl('savstudies', 'instagram'), 'https://www.instagram.com/savstudies/')
check('  tiktok', channelUrl('mrbeast', 'tiktok'), 'https://www.tiktok.com/@mrbeast')
check('  youtube', channelUrl('someone', 'youtube_shorts'), 'https://www.youtube.com/@someone')
check('  an @ is not doubled', channelUrl('@savstudies', 'instagram'), 'https://www.instagram.com/savstudies/')

// ── Rank channels, over the live pool ──────────────────────────────────────
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const pool = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  })
).json()

const site = new Map()
for (const v of pool) {
  const url = String(v?.url ?? '')
  if (!url) continue
  const h = channelOfRow(url, v.author)
  if (!h) continue
  if (!site.has(h)) site.set(h, siteOf(url))
}
const counts = {}
for (const s of site.values()) counts[s] = (counts[s] ?? 0) + 1

console.log('\nRank channels covers every site, from data we already hold:')
for (const [s, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
  console.log(`   ${s.padEnd(12)} ${n.toLocaleString()}`)
check('  instagram channels are ranked', (counts.instagram ?? 0) > 0, true)
check('  and so are tiktok ones', (counts.tiktok ?? 0) > 0, true)
// The reason the platform filter had to exist: Instagram is a fifth of the
// list, so without it those channels sit below two thousand TikTok rows.
const igShare = Math.round(((counts.instagram ?? 0) / site.size) * 100)
console.log(`   instagram is ${igShare}% of ${site.size.toLocaleString()} channels`)
check('  a filter is needed to reach them', (counts.tiktok ?? 0) > (counts.instagram ?? 0), true)

const rank = read('lib/channelRank.ts')
check('  ranking reads the author when the URL has no handle', /handleOf\(url\) \?\? \(String\(author/.test(rank), true)
check('  and records which site each channel is on', /site\.set\(handle, siteOf\(url\)\)/.test(rank), true)

// ── the ranked table can now show and pick them ───────────────────────────
const ui = read('components/VerifyLinks.tsx')
console.log('\nthe ranked table can show and pick a site:')
check('  there is a site filter', /const \[rankSite, setRankSite\] = useState\(''\)/.test(ui), true)
check('  it filters the table', /rankSite === '' \|\| c\.platform === rankSite/.test(ui), true)
check('  each chip carries its count', /siteCounts\[key\] \?\? 0/.test(ui), true)
check('  and each row says its site', /\{c\.platform\}/.test(ui), true)

// ── extraction refuses rather than fails ──────────────────────────────────
console.log('\nExtract new videos refuses the sites it cannot list, and says why:')
const stats = read('lib/linkStats.ts')
check('  the capability is declared', /export const LISTABLE_SITES = new Set\(\['tiktok'\]\)/.test(stats), true)
check('  with a helper to ask', /export function canListChannel/.test(stats), true)
check(
  '  the evidence is written down, not assumed',
  /HTTP 429, empty body/.test(stats) && /626 KB of JS shell/.test(stats),
  true
)
const route = read('app/api/admin/verify-links/extract/route.ts')
check('  the route drops non-TikTok channels', /skippedOtherSites = before - channels\.length/.test(route), true)
check('  and reports the count', /skippedOtherSites,/.test(route), true)
check('  the button offers only what it can check', /const extractable = visibleChannels\.filter\(\(c\) => c\.platform === 'tiktok'\)/.test(ui), true)
check('  and extraction runs over exactly those', /const handles = extractable\.map\(\(c\) => c\.handle\)/.test(ui), true)
check('  the confirm names the shortfall', /channel\(s\) on screen are not TikTok and cannot be/.test(ui), true)
check('  and points somewhere useful', /1_tiktok_search_scraper/.test(ui), true)

console.log('')
console.log('and there IS a way to extract Instagram: export the handles and scrape them')
check('  the export button exists', /onClick=\{exportHandles\}/.test(ui), true)
check('  it exports what is on screen', /visibleChannels\.map\(\(c\) => channelUrl\(c\.handle, c\.platform\)\)/.test(ui), true)
check('  as profile URLs, one per line', /type: 'text\/plain;charset=utf-8'/.test(ui), true)
check('  with the command to run in the header', /python scrape_channels\.py --accounts/.test(ui), true)
check('  and the chip says so', /export to scrape/.test(ui), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
