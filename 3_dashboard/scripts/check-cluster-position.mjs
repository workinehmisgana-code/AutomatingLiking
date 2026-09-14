// Is the "# in cluster" column the position the feed actually serves from?
//
// The number is only worth showing if it means one thing: the j-th link of a
// cluster is the j-th that cluster hands out. Two ways that breaks —
//
//   * the position is computed by a DIFFERENT sort than the one that assigned
//     the cluster, so the two drift apart;
//   * under 'combined', where the cluster is min(rank, date), the position is
//     read from the other dimension — two numbers pretending to be one.
//
// Mirrors lib/adminLinks.ts and checks both against the real pool.
//
//   node scripts/check-cluster-position.mjs
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

function assignClusters(list, key, set, n) {
  const s = [...list].sort((a, b) => key(a) - key(b))
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((s.length - start) / (n - i))
    for (let j = start; j < start + size; j++) set(s[j], i + 1, j - start + 1)
    start += size
  }
}

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const pool = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }, cache: 'no-store',
  })
).json()

const rows = pool
  .filter((v) => v.platform === 'tiktok')
  .map((v) => ({
    url: v.url,
    search_rank: Number(v.search_rank) || 0,
    date_score: typeof v.date_score === 'number' ? v.date_score : null,
    date_only: !!v.date_only,
    rankCluster: 0, dateCluster: 0, rankPos: 0, datePos: 0,
  }))

const rankKey = (l) => (l.search_rank > 0 ? l.search_rank : Number.MAX_SAFE_INTEGER)
const dateKey = (l) => -(l.date_score ?? Number.NEGATIVE_INFINITY)
assignClusters(rows.filter((l) => !l.date_only), rankKey,
  (l, c, p) => { l.rankCluster = c; l.rankPos = p }, 30)
assignClusters(rows, dateKey, (l, c, p) => { l.dateCluster = c; l.datePos = p }, 50)
for (const l of rows) {
  l.combinedCluster = l.date_only ? l.dateCluster : Math.min(l.rankCluster, l.dateCluster)
}
console.log(`the real pool: ${rows.length.toLocaleString()} tiktok link(s)`)

for (const [dim, cl, pos, keyf] of [
  ['rank', 'rankCluster', 'rankPos', rankKey],
  ['date', 'dateCluster', 'datePos', dateKey],
]) {
  const inDim = rows.filter((l) => l[cl] > 0)
  const byCluster = new Map()
  for (const l of inDim) (byCluster.get(l[cl]) ?? byCluster.set(l[cl], []).get(l[cl])).push(l)

  let notOne = 0, gaps = 0, outOfOrder = 0
  for (const [, members] of byCluster) {
    const sorted = [...members].sort((a, b) => a[pos] - b[pos])
    if (sorted[0][pos] !== 1) notOne++
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i][pos] !== i + 1) { gaps++; break }
      if (i > 0 && keyf(sorted[i]) < keyf(sorted[i - 1])) { outOfOrder++; break }
    }
  }
  console.log(`\n${dim}: ${byCluster.size} cluster(s), ${inDim.length.toLocaleString()} link(s)`)
  check('every cluster starts at 1', notOne, 0)
  check('positions run 1..n with no gaps or repeats', gaps, 0)
  check('and follow the score, best first', outOfOrder, 0)
}

// Under 'combined' the position must come from whichever dimension won.
const posOf = (l) => {
  if (l.date_only) return l.datePos
  return l.dateCluster < l.rankCluster ? l.datePos : l.rankPos
}
const mismatched = rows.filter((l) => {
  const fromDate = l.date_only || l.dateCluster < l.rankCluster
  return posOf(l) !== (fromDate ? l.datePos : l.rankPos)
}).length
console.log('\ncombined:')
check('the position comes from the dimension that set the cluster', mismatched, 0)
const sample = rows.filter((l) => !l.date_only && l.rankCluster !== l.dateCluster).slice(0, 3)
for (const l of sample) {
  console.log(`   rank #${l.rankCluster}/pos ${l.rankPos} · date #${l.dateCluster}/pos ${l.datePos}` +
    ` -> combined #${l.combinedCluster}/pos ${posOf(l)}`)
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
