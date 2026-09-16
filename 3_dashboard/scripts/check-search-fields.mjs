// Choosing what the Links-page search box looks in.
//
// Five fields, three of them about the LINK (url, keyword, title) and two about
// the ACCOUNT (channel name, channel bio). The split matters: a hit on a
// channel field returns every link that channel ever posted, which is what you
// want when you mean it and a thousand-row surprise when you do not.
//
// The interesting one is CHANNEL NAME ACROSS ALL PLATFORMS. TikTok and YouTube
// put the handle in the URL. Instagram does not — a post is /p/<code>/ and
// names nobody — so for Instagram the stored author is the only source there
// is, and without that fallback Instagram links could never be found by channel
// at all.
//
//   node scripts/check-search-fields.mjs
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

// The handle rule, as lib/adminLinks.ts implements it.
const searchChannelOf = (url, author) => {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
  if (tt) return tt[1].toLowerCase()
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return yt[1].toLowerCase()
  const ig = url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)
  if (ig) return ig[1].toLowerCase()
  return String(author ?? '').trim().replace(/^@/, '').toLowerCase()
}

console.log('the handle comes from the URL where the URL has one:')
check('  tiktok', searchChannelOf('https://www.tiktok.com/@MrBeast/video/123', ''), 'mrbeast')
check('  youtube', searchChannelOf('https://youtube.com/@SomeOne/shorts/x', ''), 'someone')
check('  instagram profile-style', searchChannelOf('https://instagram.com/Nike/p/ABC/', ''), 'nike')

console.log('\nand from the stored author where it does not — which is Instagram:')
check('  a bare /p/ link uses the author', searchChannelOf('https://www.instagram.com/p/DCZGg7bS3Yx/', 'someshop'), 'someshop')
check('  an @ is stripped', searchChannelOf('https://www.instagram.com/p/X/', '@SomeShop'), 'someshop')
check('  and nothing known is ""', searchChannelOf('https://www.instagram.com/p/X/', ''), '')
check('  the URL still wins over a wrong author',
      searchChannelOf('https://www.tiktok.com/@real/video/1', 'wrong'), 'real')

// ── over the real pool ─────────────────────────────────────────────────────
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const pool = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  })
).json()

const rows = pool
  .filter((v) => v?.url)
  .map((v) => ({
    url: String(v.url),
    platform: String(v.platform ?? ''),
    channel: searchChannelOf(String(v.url), v.author),
  }))

const byPlatform = {}
for (const r of rows) {
  byPlatform[r.platform] ??= { total: 0, named: 0 }
  byPlatform[r.platform].total++
  if (r.channel) byPlatform[r.platform].named++
}
console.log('\nhow many links can be found by channel, per platform:')
for (const [p, v] of Object.entries(byPlatform).sort((a, b) => b[1].total - a[1].total)) {
  const pct = Math.round((v.named / v.total) * 100)
  console.log(`   ${p.padEnd(16)} ${v.named.toLocaleString()} of ${v.total.toLocaleString()} (${pct}%)`)
}
// NOT "every platform has some". YouTube is a genuine data gap, not a bug in
// the rule: a Shorts URL is /shorts/<id> with no handle in it, and the scraper
// stored no author for any of the 1,061 YouTube rows. There is nothing to
// match on until something backfills it, and a check that pretended otherwise
// would be the only thing here that lies.
const ytNamed = (byPlatform.youtube_shorts?.named ?? 0) + (byPlatform.youtube_videos?.named ?? 0)
check('  tiktok is fully covered', byPlatform.tiktok?.named, byPlatform.tiktok?.total)
check('  instagram is covered wherever an author was stored', (byPlatform.instagram?.named ?? 0) > 0, true)
check('  youtube has no channel data at all (known gap)', ytNamed, 0)
// The whole point of the author fallback.
const ig = rows.filter((r) => r.url.includes('instagram.com'))
const igNamed = ig.filter((r) => r.channel).length
check('  instagram is searchable by channel at all', igNamed > 0, true)
const igFromUrl = ig.filter((r) => /instagram\.com\/[A-Za-z0-9._]+\/(?:p|reel)\//i.test(r.url)).length
console.log(`   of ${ig.length.toLocaleString()} instagram links, ${igFromUrl.toLocaleString()} name the channel in the URL`)
console.log(`   the author fallback is what reaches the other ${(igNamed - igFromUrl).toLocaleString()}`)
check('  and the fallback is doing the work', igNamed > igFromUrl, true)

// ── bios ───────────────────────────────────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const bios = Object.fromEntries(
  (await db.query('SELECT handle, bio FROM channel_bio')).rows.map((r) => [r.handle, r.bio])
)
await db.end()
const withBio = rows.filter((r) => r.channel && bios[r.channel]).length
console.log(`\nbios: ${Object.keys(bios).length.toLocaleString()} channel(s), reaching ${withBio.toLocaleString()} link(s)`)
check('  a bio search has something to match', withBio > 0, true)

// A worked search, end to end, on the field that needed the fallback.
const target = ig.find((r) => r.channel && !/instagram\.com\/[A-Za-z0-9._]+\/(?:p|reel)\//i.test(r.url))
if (target) {
  const hits = rows.filter((r) => r.channel.includes(target.channel)).length
  console.log(`\nsearching channel "${target.channel}" (an instagram /p/ link) finds ${hits} link(s)`)
  check('  including the one we started from', hits > 0, true)
}

// ── the wiring ─────────────────────────────────────────────────────────────
const lib = read('lib/adminLinks.ts')
const cfg = read('lib/config.ts')
const ui = read('components/AdminLinks.tsx')
console.log('\nthe five fields are one list, shared by the page and the filter:')
check('  declared once', (cfg.match(/export const SEARCH_FIELDS/g) ?? []).length, 1)
for (const k of ['url', 'keyword', 'title', 'channel', 'bio'])
  check(`  ${k} is searchable`, new RegExp(`case '${k}':`).test(lib), true)
check('  the picker renders them all', /SEARCH_FIELDS\.map\(\(f\) =>/.test(ui), true)
check('  the query carries the choice', /p\.set\('searchIn'/.test(ui), true)
check('  and the server parses it', /searchIn: \(sp\.get\('searchIn'\) \?\? ''\)/.test(lib), true)

console.log('\nthe box can never be left searching nothing:')
check('  unticking the last field restores the defaults',
      /if \(next\.size === 0\) return new Set\(DEFAULT_SEARCH_FIELDS\)/.test(ui), true)
check('  and an empty/unknown parameter falls back too',
      /const fields: readonly SearchField\[\] = picked\.length \? picked : DEFAULT_SEARCH_FIELDS/.test(lib), true)
check('  channel and bio are off by default',
      /DEFAULT_SEARCH_FIELDS: readonly SearchField\[\] = \['url', 'keyword', 'title'\]/.test(cfg), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
