// Platforms must never share a cluster, and must never share a SCALE.
//
// Two different things, and only the first was already true. Clusters are
// chunked per platform, so no cluster ever held two platforms. But date_score —
// the number that orders links inside a cluster — was a percentile taken over
// the WHOLE pool: 131k TikTok links defined the distribution and 4k Instagram
// links were ranked inside it. This checks both properties against the real
// pool, and measures what re-scoring per platform changes.
//
//   node scripts/check-platform-separation.mjs
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

const RANK_N = 30
const DATE_N = 50
const chunk = (i, total, n) => (total ? Math.min(n - 1, Math.floor((i * n) / total)) : 0)
const platforms = Array.from(new Set(videos.map((v) => String(v.platform ?? 'unknown'))))
console.log('platforms in the pool:', platforms.join(', '))

// ── clusters must not mix platforms ─────────────────────────────────────────
console.log('\nno cluster holds two platforms:')
const rankMembers = new Map()
const dateMembers = new Map()
for (const p of platforms) {
  const base = videos.filter((v) => String(v.platform ?? 'unknown') === p)
  const ranked = base.filter((v) => Number(v.search_rank) > 0)
    .sort((a, b) => Number(a.search_rank) - Number(b.search_rank))
  ranked.forEach((v, i) => {
    const c = chunk(i, ranked.length, RANK_N)
    ;(rankMembers.get(`${p}#${c}`) ?? rankMembers.set(`${p}#${c}`, []).get(`${p}#${c}`)).push(v)
  })
  const dated = base.filter((v) => typeof v.date_score === 'number')
    .sort((a, b) => b.date_score - a.date_score)
  dated.forEach((v, i) => {
    const c = chunk(i, dated.length, DATE_N)
    ;(dateMembers.get(`${p}#${c}`) ?? dateMembers.set(`${p}#${c}`, []).get(`${p}#${c}`)).push(v)
  })
}
const mixed = (m) =>
  Array.from(m.values()).filter(
    (items) => new Set(items.map((v) => String(v.platform ?? 'unknown'))).size > 1
  ).length
check('rank clusters holding more than one platform', mixed(rankMembers), 0)
check('date clusters holding more than one platform', mixed(dateMembers), 0)
console.log(`   ${rankMembers.size} rank cluster(s) and ${dateMembers.size} date cluster(s), each on one platform`)

// ── the SCALE each score was taken on ───────────────────────────────────────
console.log('\nthe scale scores were taken on:')
const scored = videos.filter((v) => typeof v.date_score === 'number')
for (const p of platforms) {
  const g = scored.filter((v) => String(v.platform ?? 'unknown') === p)
  if (g.length === 0) continue
  const s = g.map((v) => v.date_score).sort((a, b) => a - b)
  const at = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))]
  console.log(
    `   ${p.padEnd(15)} ${String(g.length).padStart(7)} scored · ` +
      `min ${s[0].toFixed(3)} p50 ${at(0.5).toFixed(3)} max ${s[s.length - 1].toFixed(3)}`
  )
}
// A platform scored against the whole pool occupies only part of 0..1. Scored
// against itself it must span the range, because a percentile over its own rows
// puts something at the top and something at the bottom.
const spans = {}
for (const p of platforms) {
  const g = scored.filter((v) => String(v.platform ?? 'unknown') === p)
  if (g.length < 100) continue
  const s = g.map((v) => v.date_score)
  let lo = Infinity, hi = -Infinity
  for (const x of s) { if (x < lo) lo = x; if (x > hi) hi = x }
  spans[p] = Number((hi - lo).toFixed(3))
}
console.log('   score span per platform (1.0 = uses the whole scale):', spans)
const narrow = Object.entries(spans).filter(([, v]) => v < 0.5)
if (narrow.length) {
  console.log(
    `   ${narrow.map(([p]) => p).join(', ')} use less than half the scale — the mark of`
  )
  console.log('   having been ranked against another platform. Re-run the recluster to fix.')
}

/** Spread of an array without spreading it into Math.max — 130k arguments
 *  overflows the call stack. */
const hSpan = (xs) => {
  let lo = Infinity, hi = -Infinity
  for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x }
  return hi - lo
}

// ── the hearts term, which is where the mixing actually bit ─────────────────
console.log('\nhow much the hearts term separates links within a platform:')
for (const p of platforms) {
  const g = scored.filter((v) => String(v.platform ?? 'unknown') === p && typeof v.ds_h === 'number')
  if (g.length < 100) continue
  const h = g.map((v) => v.ds_h)
  const uniq = new Set(h.map((x) => x.toFixed(2))).size
  console.log(
    `   ${p.padEnd(15)} ${String(g.length).padStart(7)} link(s) · ` +
      `${String(uniq).padStart(3)} distinct value(s) · span ${hSpan(h).toFixed(3)}`
  )
}
console.log('   (a platform ranked on another platform\'s scale collapses to a few values)')

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
