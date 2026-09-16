// "Extract comments" reads the links the page is showing.
//
// It had its own copy of the query parser, and the copy had drifted:
//
//   * clusters kept NON-POSITIVE numbers. With no cluster ticked the page omits
//     the parameter; ''.split(',') is [''], Number('') is 0, so the scan ran
//     with clusters = [0] — a filter for a cluster no link belongs to.
//   * the title filter was read from `titleFilter`; the page sends `title`.
//   * eight filters were not read at all: ours, oursProduct, minOurs, maxOurs,
//     retired, unrelated, blocked, category.
//
// The [0] never showed up, because date-only links had no rank cluster and so
// scored 0 — the scan quietly read THOSE instead of the filtered set. Once the
// Search rank tab stopped listing date-only links, cluster 0 became empty and
// the bug surfaced as "No TikTok links match this filter."
//
// Both routes now share one parser. Checked here: that they do, that the parser
// has the guard, and that the rank tab really does have TikTok links to read.
//
//   node scripts/check-scan-filter.mjs
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

// ── the parse rule itself ──────────────────────────────────────────────────
const broken = (v) => (v ?? '').split(',').map(Number).filter((n) => Number.isFinite(n))
const fixed = (v) => (v ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0)

console.log('an absent clusters parameter means "no cluster filter":')
check('  the old rule invented cluster 0', broken(null), [0])
check('  the new rule invents nothing', fixed(null), [])
check('  an empty string too', fixed(''), [])
check('  a real selection still parses', fixed('1,2,5'), [1, 2, 5])
check('  and junk is dropped', fixed('1,,0,-3,abc,4'), [1, 4])

// ── one parser, used by both ───────────────────────────────────────────────
const lib = read('lib/adminLinks.ts')
const listRoute = read('app/api/admin/links/list/route.ts')
const scanRoute = read('app/api/admin/links/scan-comments/route.ts')

console.log('\nthere is one parser and both routes use it:')
check('  it is exported once', (lib.match(/export function parseLinkQuery/g) ?? []).length, 1)
check('  it carries the guard', /Number\.isFinite\(n\) && n > 0/.test(lib), true)
check('  the list route calls it', /parseLinkQuery\(sp\)/.test(listRoute), true)
check('  the scan route calls it', /parseLinkQuery\(sp\)/.test(scanRoute), true)
check('  the scan route has no parser of its own', /function parseQuery/.test(scanRoute), false)

console.log('\nthe filters the scan used to ignore are read now:')
for (const f of ['ours', 'oursProduct', 'minOurs', 'maxOurs', 'retired', 'unrelated', 'blocked', 'category'])
  check(`  ${f}`, new RegExp(`sp\\.get\\('${f}'\\)`).test(lib), true)
check("  the title filter reads the page's key", /sp\.get\('title'\)/.test(lib), true)

// ── and there is something to scan ─────────────────────────────────────────
const RANK_CLUSTER_COUNT = 30
function assignClusters(list, key, set, n) {
  const s = [...list].sort((a, b) => key(a) - key(b))
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((s.length - start) / (n - i))
    for (let j = start; j < start + size; j++) set(s[j], i + 1)
    start += size
  }
}

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const pool = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  })
).json()
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const blocked = new Set((await db.query('SELECT url FROM blocked_link')).rows.map((r) => r.url))
await db.end()

const rows = pool
  .filter((v) => v?.url)
  .map((v) => ({
    url: String(v.url),
    platform: String(v.platform ?? ''),
    date_only: Boolean(v.date_only),
    search_rank: Number(v.search_rank ?? 0),
    blocked: blocked.has(String(v.url)),
    rankCluster: 0,
  }))
const byPlatform = new Map()
for (const r of rows) {
  if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, [])
  byPlatform.get(r.platform).push(r)
}
byPlatform.forEach((l) =>
  assignClusters(
    l.filter((x) => !x.date_only),
    (x) => (x.search_rank > 0 ? x.search_rank : Number.MAX_SAFE_INTEGER),
    (x, c) => { x.rankCluster = c },
    RANK_CLUSTER_COUNT
  )
)

// The scan's own gate: TikTok video/photo URLs, never a blocked link.
const TIKTOK = /tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i
const rankTab = rows.filter((l) => !l.date_only && !l.blocked)
const scannable = rankTab.filter((l) => TIKTOK.test(l.url))

console.log('\non the Search rank tab, with no cluster ticked:')
check('  the scan finds TikTok links', scannable.length > 0, true)
console.log(`   ${scannable.length.toLocaleString()} TikTok link(s) of ${rankTab.length.toLocaleString()} on the tab`)

const withZero = scannable.filter((l) => l.rankCluster === 0).length
console.log('\nand the [0] filter would still find none, which is why it failed:')
check('  no link sits in cluster 0', withZero, 0)

const per = {}
for (const l of scannable) per[l.rankCluster] = (per[l.rankCluster] ?? 0) + 1
const ticked = [1, 2, 3]
const n = ticked.reduce((a, c) => a + (per[c] ?? 0), 0)
console.log(`\nwith clusters ${ticked.join(', ')} ticked: ${n} TikTok link(s)`)
check('  a real selection finds links too', n > 0, true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
