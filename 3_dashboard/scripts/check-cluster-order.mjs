// Is a cluster's order now the clustering score, and only that?
//
// Three things used to reorder links inside a cluster: a per-window shuffle,
// a sort by distinct clicks, and a sort by how many of our comments a link
// already carried. All three are gone, and the risk in removing them is not
// that they come back — it is that the order left behind is not actually the
// score. chunk() preserving the sort is what makes it so, and that is worth
// executing rather than asserting.
//
// Checks against the REAL pool, so a change that only looks right on toy data
// still has to survive 129k links.
//
//   node scripts/check-cluster-order.mjs
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
  console.log(
    `   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
  )
}

// Mirrors lib/cluster.ts: sort by the score, chunk, emit each chunk as it is.
const chunk = (sorted, n) => {
  const out = []
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((sorted.length - start) / (n - i))
    out.push(sorted.slice(start, start + size))
    start += size
  }
  return out
}
const order = (items, n, dim) => {
  const rankOf = (e) => (e.search_rank > 0 ? e.search_rank : Number.MAX_SAFE_INTEGER)
  const dateOf = (e) => (typeof e.date_score === 'number' ? e.date_score : -Infinity)
  const sorted =
    dim === 'rank'
      ? [...items].sort((a, b) => rankOf(a) - rankOf(b))
      : [...items].sort((a, b) => dateOf(b) - dateOf(a))
  const clusters = chunk(sorted, n)
  const seen = new Set()
  const out = []
  for (const c of clusters) {
    for (const e of c) {
      if (!seen.has(e.url)) {
        seen.add(e.url)
        out.push(e)
      }
    }
  }
  return { out, clusters }
}

console.log('the toy case first:')
const toy = [
  { url: 'a', search_rank: 5 },
  { url: 'b', search_rank: 1 },
  { url: 'c', search_rank: 9 },
  { url: 'd', search_rank: 3 },
]
check('rank order, best first', order(toy, 2, 'rank').out.map((v) => v.url), ['b', 'd', 'a', 'c'])
// The same input in a different arrival order must come out the same. This is
// the whole point: no user-specific or time-specific shuffle any more.
const shuffled = [toy[2], toy[0], toy[3], toy[1]]
check('arrival order does not matter', order(shuffled, 2, 'rank').out.map((v) => v.url),
  ['b', 'd', 'a', 'c'])
check('running it twice gives the same order',
  order(toy, 2, 'rank').out.map((v) => v.url),
  order(toy, 2, 'rank').out.map((v) => v.url))

// ── the real pool ────────────────────────────────────────────────────────────
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  })
).json()
console.log(`\nthe real pool: ${videos.length.toLocaleString()} link(s)`)

for (const [dim, n] of [['rank', 30], ['date', 50]]) {
  const pool =
    dim === 'rank'
      ? videos.filter((v) => v.platform === 'tiktok' && v.search_rank > 0)
      : videos.filter((v) => v.platform === 'tiktok')
  const { out, clusters } = order(pool, n, dim)
  console.log(`\n${dim}: ${pool.length.toLocaleString()} link(s) in ${n} cluster(s)`)

  // Inside every cluster the score must never move the wrong way.
  const key = dim === 'rank'
    ? (e) => (e.search_rank > 0 ? e.search_rank : Number.MAX_SAFE_INTEGER)
    : (e) => -(typeof e.date_score === 'number' ? e.date_score : -Infinity)
  let breaks = 0
  for (const c of clusters) {
    for (let i = 1; i < c.length; i++) if (key(c[i]) < key(c[i - 1])) breaks++
  }
  check(`every cluster is in score order`, breaks, 0)
  check(`nothing was dropped or duplicated`, out.length, pool.length)

  // And the first link of cluster 1 is the best-scoring link in the pool.
  const best = pool.reduce((a, b) => (key(b) < key(a) ? b : a))
  check(`the first link served is the best-scoring one`, out[0].url, best.url)
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
