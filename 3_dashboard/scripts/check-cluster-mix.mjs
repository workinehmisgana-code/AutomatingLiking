// Does the rank/date mix actually come out at the percentage that was set?
//
// The setting is a promise: "75% of served links come from the posted-date
// clustering". Two things could quietly break that promise and neither would
// look like a bug from the outside.
//
//   1. The two orderings overlap almost completely — nearly every link has both
//      a rank and a date. A draw spent on a link the other side already served
//      would count toward the ratio while producing nothing, and the realised
//      share would drift below the setting.
//   2. A per-user seed is only worth having if users actually differ. If the
//      seeding were weak, everyone would get the same blend and this would be
//      the old shared schedule wearing a new name.
//
// Measured against the REAL pool, at the batch size the app actually takes.
//
//   node scripts/check-cluster-mix.mjs
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

// Mirrors lib/clusterMix.ts.
const clampShare = (n) => {
  if (n === null || n === undefined) return 75
  if (typeof n === 'string' && n.trim() === '') return 75
  const v = Number(n)
  if (!Number.isFinite(v)) return 75
  return Math.max(0, Math.min(100, Math.round(v)))
}
const seedFrom = (key) => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}
const rng = (seed) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const mixOrderings = (rankOrder, dateOrder, dateShare, seed, limit = Infinity) => {
  const share = clampShare(dateShare)
  const next = rng(seed)
  const seen = new Set()
  const out = []
  let i = 0
  let j = 0
  const from = []
  const skipSeen = () => {
    while (i < rankOrder.length && seen.has(rankOrder[i].url)) i++
    while (j < dateOrder.length && seen.has(dateOrder[j].url)) j++
  }
  skipSeen()
  while (out.length < limit && (i < rankOrder.length || j < dateOrder.length)) {
    const takeDate = j < dateOrder.length && (i >= rankOrder.length || next() * 100 < share)
    const e = takeDate ? dateOrder[j++] : rankOrder[i++]
    seen.add(e.url)
    out.push(e)
    from.push(takeDate ? 'date' : 'rank')
    skipSeen()
  }
  return { out, from }
}

console.log('the setting itself:')
check('the default', clampShare(null), 75)
check('an empty box means the default, never 0', clampShare(''), 75)
check('nonsense means the default', clampShare('abc'), 75)
check('0 is honoured when actually typed', clampShare(0), 0)
check('100 too', clampShare(100), 100)
check('above 100 is clamped', clampShare(140), 100)
check('below 0 is clamped', clampShare(-20), 0)
check('decimals round', clampShare(74.6), 75)

// ── the real pool ────────────────────────────────────────────────────────────
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  })
).json()

const pool = videos.filter((v) => v.platform === 'tiktok')
const rankOrder = pool
  .filter((v) => v.search_rank > 0)
  .sort((a, b) => a.search_rank - b.search_rank)
const dateOrder = [...pool].sort(
  (a, b) =>
    (typeof b.date_score === 'number' ? b.date_score : -Infinity) -
    (typeof a.date_score === 'number' ? a.date_score : -Infinity)
)
const BATCH = 1000
console.log(
  `\nthe real pool: ${pool.length.toLocaleString()} tiktok link(s) — ` +
    `${rankOrder.length.toLocaleString()} with a search rank, batch of ${BATCH}`
)

for (const share of [75, 25, 50, 100, 0]) {
  const shares = []
  for (let u = 0; u < 200; u++) {
    const { from } = mixOrderings(rankOrder, dateOrder, share, seedFrom(`user${u}@x.com`), BATCH)
    shares.push((100 * from.filter((f) => f === 'date').length) / from.length)
  }
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length
  const off = Math.abs(mean - share)
  console.log(`   set ${String(share).padStart(3)}%  ->  realised ${mean.toFixed(1)}% across 200 users`)
  // Overlap between the two orderings is what would drag this down.
  check(`  a ${share}% setting lands within 2 points`, off < 2, true)
}

console.log('\nusers differ, and each user is stable:')
const seeds = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']
const firsts = seeds.map(
  (s) => mixOrderings(rankOrder, dateOrder, 75, seedFrom(s), 40).out.map((v) => v.url).join('|')
)
check('five users get five different blends', new Set(firsts).size, 5)
check(
  'the same user gets the same blend twice',
  mixOrderings(rankOrder, dateOrder, 75, seedFrom('a@x.com'), 40).out.map((v) => v.url).join('|'),
  firsts[0]
)

console.log('\nthe orderings themselves are untouched:')
const { out, from } = mixOrderings(rankOrder, dateOrder, 75, seedFrom('z@x.com'), 500)
// Whatever the blend, a link drawn from the rank side must never appear before
// a better-ranked link that was also drawn from the rank side.
const rankSeq = out.filter((_, i) => from[i] === 'rank').map((v) => v.search_rank)
const dateSeq = out.filter((_, i) => from[i] === 'date').map((v) => v.date_score ?? -Infinity)
check('rank draws stay in rank order', rankSeq.every((v, i) => i === 0 || v >= rankSeq[i - 1]), true)
check('date draws stay in date order', dateSeq.every((v, i) => i === 0 || v <= dateSeq[i - 1]), true)
check('no link is served twice', new Set(out.map((v) => v.url)).size, out.length)

console.log('\nrunning out of one side does not end the feed:')
const tiny = rankOrder.slice(0, 5)
const big = dateOrder.slice(0, 300)
const drained = mixOrderings(tiny, big, 50, 1, 200)
check('the feed still fills from the other side', drained.out.length, 200)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
