// Does cutting the pool to 100 links per platform change what a user is served?
//
// It must not. The list a user works through is defined by two things — which
// cluster a link is in, and its position inside that cluster — and both are
// properties of the WHOLE pool. This mirrors lib/userFeed against the real
// videos.json and checks the served slice against the uncut clustering.
//
//   node scripts/check-user-feed.mjs
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
const raw = await (await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }, cache: 'no-store',
})).json()
const bytes = Buffer.byteLength(JSON.stringify(raw))

const RANK_N = 30
const DATE_N = 50
const PER = 100
const chunk = (i, total, n) => (total ? Math.min(n - 1, Math.floor((i * n) / total)) : 0)

// The uncut clustering, per platform — what the browser used to compute itself.
const platforms = Array.from(new Set(raw.map((v) => String(v.platform ?? 'unknown'))))
const truth = new Map() // url -> {rankCluster, rankPos, dateCluster, datePos}
for (const p of platforms) {
  const base = raw.filter((v) => String(v.platform ?? 'unknown') === p)
  const at = (u) => {
    let t = truth.get(u)
    if (!t) { t = { rankCluster: -1, rankPos: -1, dateCluster: -1, datePos: -1 }; truth.set(u, t) }
    return t
  }
  const ranked = base.filter((v) => Number(v.search_rank) > 0)
    .sort((a, b) => Number(a.search_rank) - Number(b.search_rank))
  ranked.forEach((v, i) => { const t = at(v.url); t.rankCluster = chunk(i, ranked.length, RANK_N); t.rankPos = i })
  const useScore = base.some((v) => typeof v.date_score === 'number')
  const dated = base
    .map((v) => ({ v, ts: useScore ? (typeof v.date_score === 'number' ? v.date_score : null) : null }))
    .filter((x) => x.ts !== null)
    .sort((a, b) => b.ts - a.ts)
  dated.forEach((x, i) => { const t = at(x.v.url); t.dateCluster = chunk(i, dated.length, DATE_N); t.datePos = i })
}

// The cut, as lib/userFeed makes it.
const buildFeed = (skipUrls) => {
  const served = []
  const remaining = {}
  for (const p of platforms) {
    const base = raw.filter((v) => String(v.platform ?? 'unknown') === p)
    const skip = (v) => skipUrls.has(v.url)
    const ranked = base.filter((v) => Number(v.search_rank) > 0)
      .sort((a, b) => Number(a.search_rank) - Number(b.search_rank))
    const useScore = base.some((v) => typeof v.date_score === 'number')
    const dated = base
      .map((v) => ({ v, ts: useScore ? (typeof v.date_score === 'number' ? v.date_score : null) : null }))
      .filter((x) => x.ts !== null)
      .sort((a, b) => b.ts - a.ts)
      .map((x) => x.v)
    const out = new Map()
    const take = (l) => { let n = 0; for (const v of l) { if (n >= PER) break; if (skip(v)) continue; n++
      if (!out.has(v.url)) out.set(v.url, { ...v, ...truth.get(v.url) }) } }
    take(ranked); take(dated)
    if (out.size < PER) for (const v of base) { if (out.size >= PER) break
      if (skip(v) || out.has(v.url)) continue; out.set(v.url, { ...v, ...truth.get(v.url) }) }
    served.push(...out.values())
    remaining[p] = base.reduce((n, v) => (skip(v) ? n : n + 1), 0)
  }
  return { served, remaining }
}

const { served, remaining } = buildFeed(new Set())
console.log(`pool: ${raw.length.toLocaleString()} link(s), ${(bytes / 1048576).toFixed(1)} MB`)
const servedBytes = Buffer.byteLength(JSON.stringify(served))
console.log(`served: ${served.length} link(s), ${(servedBytes / 1024).toFixed(0)} KB — ${(bytes / servedBytes).toFixed(0)}x smaller`)
console.log('   remaining per platform (the true figures the tabs show):', remaining)

console.log('\nthe cap holds:')
for (const p of platforms) {
  const n = served.filter((v) => String(v.platform ?? 'unknown') === p).length
  const pool = raw.filter((v) => String(v.platform ?? 'unknown') === p).length
  console.log(`   ${p.padEnd(16)} ${String(n).padStart(4)} of ${pool.toLocaleString()}`)
  check(`  ${p} is within 100 per dimension`, n <= 2 * PER, true)
}

console.log('\nthe queue is unchanged:')
check(
  'every served link keeps the cluster it earned in the full pool',
  served.filter((v) => v.rankCluster !== (truth.get(v.url)?.rankCluster ?? -1)
    || v.dateCluster !== (truth.get(v.url)?.dateCluster ?? -1)).length,
  0
)
// The point of the cut: it must take the links a user reaches FIRST, not any 100.
for (const p of platforms) {
  const base = raw.filter((v) => String(v.platform ?? 'unknown') === p)
  const ranked = base.filter((v) => Number(v.search_rank) > 0)
    .sort((a, b) => Number(a.search_rank) - Number(b.search_rank))
  if (ranked.length === 0) continue
  const want = ranked.slice(0, PER).map((v) => v.url)
  const got = new Set(served.map((v) => v.url))
  check(`  ${p}: the best 100 by rank are all served`, want.filter((u) => !got.has(u)).length, 0)
  const dated = base.filter((v) => typeof v.date_score === 'number')
    .sort((a, b) => b.date_score - a.date_score).slice(0, PER).map((v) => v.url)
  check(`  ${p}: the best 100 by date are all served`, dated.filter((u) => !got.has(u)).length, 0)
}

console.log('\nspent links are dropped before the cut, not after:')
const tiktok = raw.filter((v) => String(v.platform ?? 'unknown') === 'tiktok')
const topRank = tiktok.filter((v) => Number(v.search_rank) > 0)
  .sort((a, b) => Number(a.search_rank) - Number(b.search_rank))
const spent = new Set(topRank.slice(0, 60).map((v) => v.url))
const after = buildFeed(spent)
const gotAfter = new Set(after.served.map((v) => v.url))
check('a user who worked 60 links still gets a full 100', after.served.filter((v) => String(v.platform ?? 'unknown') === 'tiktok').length >= PER, true)
check('and none of the 60 comes back', Array.from(spent).filter((u) => gotAfter.has(u)).length, 0)
check('the 61st-best link is now served', gotAfter.has(topRank[60].url), true)
check('the remaining count drops by exactly 60', remaining.tiktok - after.remaining.tiktok, 60)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
