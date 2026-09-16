// Are the clusters cut per platform, in BOTH dimensions, everywhere?
//
// "Independently for all platforms" has two halves, and only one of them is
// visible in the grouping:
//
//   MEMBERSHIP — which links land in cluster 1. Chunking the whole pool at once
//     would put 138k TikTok links and 15k Instagram links on one ladder, and
//     Instagram would simply not appear near the top.
//
//   THE SCORE the chunking sorts by. Every part of date_score is a PERCENTILE —
//     a link's place in a distribution — so the set it is ranked against decides
//     the number. Ranked across the pool, Instagram's like counts sit in one
//     narrow band of the TikTok scale and the hearts term stops separating
//     Instagram links from each other at all. Clusters were already chunked per
//     platform then, so this half was invisible in the grouping and showed up
//     only as a worse ORDER inside each Instagram cluster.
//
// This checks both, against the live pool, and quantifies the difference rather
// than asserting it — a "yes it is per platform" that cannot say what would
// change is not evidence of anything.
//
//   node scripts/check-cluster-independence.mjs
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

const RANK_N = 30
const DATE_N = 100

// lib/adminLinks.ts assignClusters: equal counts, best first.
function assign(list, key, nWanted) {
  const out = new Map()
  const s = [...list].sort((a, b) => key(a) - key(b))
  // Capped at the number of links, as lib/adminLinks.ts does. Without the cap a
  // platform with fewer links than clusters fills the LAST clusters, because
  // every early chunk rounds down to zero, so its best link is never in
  // cluster 1 and never reached by anyone working clusters 1-3.
  const n = Math.max(1, Math.min(nWanted, s.length))
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((s.length - start) / (n - i))
    for (let j = start; j < start + size; j++) out.set(s[j].url, i + 1)
    start += size
  }
  return out
}

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const pool = (
  await (
    await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
  ).json()
).filter((v) => v?.url)

const rows = pool.map((v) => ({
  url: String(v.url),
  platform: String(v.platform ?? 'unknown'),
  search_rank: Number(v.search_rank ?? 0),
  date_only: Boolean(v.date_only),
  date_score: typeof v.date_score === 'number' ? v.date_score : null,
}))

const UNSCORED = Number.MAX_SAFE_INTEGER
const rankKey = (l) => (l.search_rank > 0 ? l.search_rank : UNSCORED)
const dateKey = (l) => (l.date_score !== null ? -l.date_score : UNSCORED)

const byPlatform = new Map()
for (const r of rows) {
  if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, [])
  byPlatform.get(r.platform).push(r)
}

console.log('the pool, by platform:')
for (const [p, list] of [...byPlatform].sort((a, b) => b[1].length - a[1].length))
  console.log(`   ${p.padEnd(16)} ${list.length.toLocaleString()}`)
check('  every row has a known platform', [...byPlatform.keys()].filter((p) => p === 'unknown'), [])

// ── membership: per platform vs one shared ladder ──────────────────────────
for (const [dim, key, n, eligible] of [
  ['search rank', rankKey, RANK_N, (l) => !l.date_only],
  ['posted date', dateKey, DATE_N, () => true],
]) {
  console.log(`\n${dim}: per platform vs one shared ladder`)
  const perPlatform = new Map()
  byPlatform.forEach((list) => {
    for (const [url, c] of assign(list.filter(eligible), key, n)) perPlatform.set(url, c)
  })
  const pooled = assign(rows.filter(eligible), key, n)

  let moved = 0
  for (const [url, c] of perPlatform) if (pooled.get(url) !== c) moved++
  const pct = Math.round((moved / Math.max(1, perPlatform.size)) * 100)
  console.log(`   ${moved.toLocaleString()} of ${perPlatform.size.toLocaleString()} links (${pct}%) would sit in a different cluster if the pool were chunked as one`)
  check('  the two really do differ', moved > 0, true)

  // Every platform must reach cluster 1 — the whole point. On a shared ladder
  // the smaller platforms are crowded out of the top.
  const topPer = new Set()
  const topPooled = new Set()
  for (const r of rows.filter(eligible)) {
    if (perPlatform.get(r.url) === 1) topPer.add(r.platform)
    if (pooled.get(r.url) === 1) topPooled.add(r.platform)
  }
  console.log(`   cluster 1 holds: per platform ${[...topPer].sort().join(', ')}`)
  console.log(`                    pooled       ${[...topPooled].sort().join(', ')}`)
  check('  per platform, every platform reaches cluster 1', topPer.size, byPlatform.size)

  // And each platform's clusters are evenly filled within itself.
  for (const [p, list] of byPlatform) {
    const mine = list.filter(eligible)
    if (mine.length < n) continue
    const sizes = new Map()
    for (const r of mine) {
      const c = perPlatform.get(r.url)
      sizes.set(c, (sizes.get(c) ?? 0) + 1)
    }
    const vals = [...sizes.values()]
    check(`  ${p}: ${n} clusters, sizes within 1`, Math.max(...vals) - Math.min(...vals) <= 1, true)
  }
}

// ── the score the date chunking sorts by ──────────────────────────────────
console.log('\na platform thinner than the cluster count still starts at cluster 1:')
for (const [p, list] of byPlatform) {
  const ranked = list.filter((l) => !l.date_only)
  if (ranked.length === 0 || ranked.length >= RANK_N) continue
  const c = assign(ranked, rankKey, RANK_N)
  const clusters = [...new Set(c.values())].sort((a, b) => a - b)
  console.log(`   ${p}: ${ranked.length} ranked link(s) -> cluster(s) ${clusters.join(', ')}`)
  check(`  ${p} reaches cluster 1`, clusters[0], 1)
  check(`  ${p} uses no more clusters than it has links`, clusters.length <= ranked.length, true)
}

console.log('\nthe stored date_score is itself per platform:')
const pctl = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN
}
const medians = []
for (const [p, list] of byPlatform) {
  const sc = list.map((r) => r.date_score).filter((x) => x !== null)
  if (sc.length < 100) continue
  const m = pctl(sc, 0.5)
  medians.push([p, m])
  console.log(`   ${p.padEnd(16)} p10=${pctl(sc, 0.1).toFixed(3)} p50=${m.toFixed(3)} p90=${pctl(sc, 0.9).toFixed(3)}`)
}
// Scored against its own kind, every platform's median lands near the middle.
// Pooled, a small platform's median collapses — it was 0.047 for Instagram
// against 0.507 for TikTok before this was fixed.
const spread = Math.max(...medians.map((x) => x[1])) - Math.min(...medians.map((x) => x[1]))
check('  every platform sits near its own middle', medians.every(([, m]) => m > 0.3 && m < 0.7), true)
check(`  medians are within 0.15 of each other (${spread.toFixed(3)})`, spread < 0.15, true)

// ── every path that clusters, clusters one platform at a time ─────────────
console.log('\nevery code path groups before it chunks:')
const admin = read('lib/adminLinks.ts')
check('  admin page: rank', /byPlatform\.forEach\(\(list\) => \{[\s\S]{0,400}RANK_CLUSTER_COUNT/.test(admin), true)
check('  admin page: date', /byPlatform\.forEach\(\(list\) => \{[\s\S]{0,700}DATE_CLUSTER_COUNT/.test(admin), true)
const feed = read('lib/userFeed.ts')
check('  web feed groups first', /const byPlatform = new Map<string, T\[\]>\(\)/.test(feed), true)
check('  and chunks inside one platform', /function forPlatform<T extends FeedVideo>/.test(feed), true)
const appRoute = read('app/api/app/links/route.ts')
check('  app feed filters to one platform', /const pool = available\.filter\(\(v\) => String\(v\.platform \?\? ''\) === p\)/.test(appRoute), true)
const dash = read('components/Dashboard.tsx')
check('  the web page clusters its own platform', /const base = videos\.filter\(\(v\) => v\.platform === platform\)/.test(dash), true)
check('  and reads the stamped cluster per platform', /if \(v\.platform !== platform\) continue/.test(dash), true)
const score = read('lib/dateScore.ts')
check('  scoring groups by platform', /const groups = new Map<string, Scorable\[\]>\(\)/.test(score), true)
check('  and scores each group alone', /function scoreOnePlatform/.test(score), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
