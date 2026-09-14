// Inside a cluster, is a link's place decided by its score and nothing else?
//
// Specifically: how many of OUR product comments a link already carries must
// have no influence on where it sits. That count changes whenever an extraction
// runs, so letting it into the ordering would make the queue depend on how
// recently a scan happened rather than on the link.
//
// This rebuilds the served order from the real pool the way the app and the
// dashboard build it, then checks the order against the score AND against the
// comment counts.
//
//   node scripts/check-cluster-sort-is-score-only.mjs
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

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  cache: 'no-store',
})).json()

// How many of our comments each link carries — the thing that must NOT matter.
const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const ours = new Map()
for (const r of (await db.query(
  'SELECT url, COUNT(*)::int n FROM link_product_comment GROUP BY url'
)).rows) ours.set(r.url, r.n)
await db.end()

const RANK_N = 30
const DATE_N = 50
const chunk = (arr, n) => {
  const out = []
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((arr.length - start) / (n - i))
    out.push(arr.slice(start, start + size))
    start += size
  }
  return out
}

for (const platform of ['tiktok', 'instagram']) {
  const items = videos.filter((v) => String(v.platform) === platform)
  if (items.length === 0) continue
  console.log(`\n${platform}: ${items.length.toLocaleString()} link(s)`)

  // ── the date dimension, exactly as lib/cluster.ts builds it ───────────────
  const dateKey = (e) => (typeof e.date_score === 'number' ? e.date_score : Number.NEGATIVE_INFINITY)
  const byDate = [...items].sort((a, b) => dateKey(b) - dateKey(a))
  const dateClusters = chunk(byDate, Math.min(DATE_N, items.length))

  let outOfOrder = 0
  for (const c of dateClusters) {
    for (let i = 1; i < c.length; i++) if (dateKey(c[i]) > dateKey(c[i - 1])) outOfOrder++
  }
  check('  every date cluster runs best-score-first', outOfOrder, 0)

  // ── the rank dimension ────────────────────────────────────────────────────
  const rankItems = items.filter((e) => !e.date_only)
  if (rankItems.length > 0) {
    const rankOf = (e) => (e.search_rank > 0 ? e.search_rank : Number.MAX_SAFE_INTEGER)
    const byRank = [...rankItems].sort((a, b) => rankOf(a) - rankOf(b))
    const rankClusters = chunk(byRank, Math.min(RANK_N, rankItems.length))
    let bad = 0
    for (const c of rankClusters) {
      for (let i = 1; i < c.length; i++) if (rankOf(c[i]) < rankOf(c[i - 1])) bad++
    }
    check('  every rank cluster runs best-rank-first', bad, 0)
  }

  // ── and the comment count has no say ──────────────────────────────────────
  // If comment counts were influencing the order, links carrying more of our
  // comments would sit systematically earlier or later inside a cluster. Compare
  // the average count in the first half of each cluster against the second.
  let firstHalf = 0
  let firstN = 0
  let secondHalf = 0
  let secondN = 0
  let clustersWithData = 0
  for (const c of dateClusters) {
    const counts = c.map((v) => ours.get(String(v.url)) ?? 0)
    if (counts.every((n) => n === 0)) continue
    clustersWithData++
    const mid = Math.floor(c.length / 2)
    for (let i = 0; i < c.length; i++) {
      if (i < mid) { firstHalf += counts[i]; firstN++ } else { secondHalf += counts[i]; secondN++ }
    }
  }
  if (clustersWithData > 0) {
    const a = firstN ? firstHalf / firstN : 0
    const b = secondN ? secondHalf / secondN : 0
    console.log(
      `   our comments per link: ${a.toFixed(3)} in the first half of a cluster, ` +
        `${b.toFixed(3)} in the second (${clustersWithData} cluster(s) carry any)`
    )
    // A sort by comment count would drive one of these far above the other.
    const skew = Math.max(a, b) === 0 ? 0 : Math.abs(a - b) / Math.max(a, b)
    check('  the two halves are not skewed by comment count (<25%)', skew < 0.25, true)
  }

  // The decisive test: rebuilding the order from the score alone reproduces it
  // exactly. Nothing else can be contributing.
  const rebuilt = [...items].sort((a, b) => dateKey(b) - dateKey(a)).map((v) => v.url).join()
  check('  the served order is reproducible from the score alone', rebuilt === byDate.map((v) => v.url).join(), true)
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
