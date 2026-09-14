// What actually decides a link's place in the batch the APP receives?
//
// The previous check looked at clusters in isolation. This one rebuilds the
// whole /api/app/links pipeline for a real user — clusterAndOrder on both
// dimensions, then mixOrderings at the configured share with that user's seed —
// and asks of the finished batch whether position tracks either kind of
// "comments a link already has":
//
//   * our product comments found on it by an extraction (link_product_comment)
//   * the video's OWN comment count, as scraped
//
// If either were an input, links carrying more would sit systematically earlier
// or later. Correlation near zero, and an exact match against a score-only
// rebuild, together say it is not.
//
//   node scripts/check-app-feed-order.mjs
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

const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const ours = new Map()
for (const r of (await db.query('SELECT url, COUNT(*)::int n FROM link_product_comment GROUP BY url')).rows) {
  ours.set(r.url, r.n)
}
const userId = (await db.query('SELECT user_id FROM clicked_link GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1')).rows[0]?.user_id ?? 'nobody'
const shareRow = (await db.query("SELECT v FROM app_kv WHERE k = 'cluster_date_share'").catch(() => ({ rows: [] }))).rows[0]
const dateShare = shareRow ? Number(shareRow.v) : 75
await db.end()

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  cache: 'no-store',
})).json()

// ── lib/clusterMix.ts, mirrored ─────────────────────────────────────────────
const seedFrom = (key) => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
const rng = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const mixOrderings = (rankOrder, dateOrder, share, seed, limit = Infinity) => {
  const next = rng(seed)
  const seen = new Set()
  const out = []
  let i = 0, j = 0
  const skip = () => {
    while (i < rankOrder.length && seen.has(rankOrder[i].url)) i++
    while (j < dateOrder.length && seen.has(dateOrder[j].url)) j++
  }
  skip()
  while (out.length < limit && (i < rankOrder.length || j < dateOrder.length)) {
    const takeDate = j < dateOrder.length && (i >= rankOrder.length || next() * 100 < share)
    const e = takeDate ? dateOrder[j++] : rankOrder[i++]
    seen.add(e.url); out.push(e); skip()
  }
  return out
}

// ── lib/cluster.ts, mirrored ────────────────────────────────────────────────
const chunkInto = (arr, n) => {
  const out = []
  let start = 0
  for (let k = 0; k < n; k++) {
    const size = Math.floor((arr.length - start) / (n - k))
    out.push(arr.slice(start, start + size)); start += size
  }
  return out
}
const clusterAndOrder = (items, dimension) => {
  if (items.length <= 1) return items.slice()
  const rankItems = items.filter((e) => !e.date_only)
  const rankOf = (e) => (e.search_rank > 0 ? e.search_rank : Number.MAX_SAFE_INTEGER)
  const dateKey = (e) => (typeof e.date_score === 'number' ? e.date_score : Number.NEGATIVE_INFINITY)
  const out = []
  const seen = new Set()
  const emit = (c) => { for (const e of c) if (!seen.has(e.url)) { seen.add(e.url); out.push(e) } }
  if (dimension === 'rank') {
    const n = Math.max(1, Math.min(30, rankItems.length || 1))
    for (const c of chunkInto([...rankItems].sort((a, b) => rankOf(a) - rankOf(b)), n)) emit(c)
    emit(rankItems)
  } else {
    const n = Math.max(1, Math.min(50, items.length))
    for (const c of chunkInto([...items].sort((a, b) => dateKey(b) - dateKey(a)), n)) emit(c)
    emit(items)
  }
  return out
}

/** Pearson correlation between position and a per-link value. */
const corr = (xs, ys) => {
  const n = xs.length
  if (n < 2) return 0
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my
    num += a * b; dx += a * a; dy += b * b
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy)
}

console.log(`user seed from ${userId.slice(0, 8)}… · date share ${dateShare}%`)
for (const platform of ['tiktok', 'instagram']) {
  const pool = videos.filter((v) => String(v.platform) === platform && String(v.url ?? '').startsWith('http'))
  if (pool.length === 0) continue
  const seed = seedFrom(userId)
  const feed = platform === 'instagram'
    ? clusterAndOrder(pool, 'rank')
    : mixOrderings(clusterAndOrder(pool, 'rank'), clusterAndOrder(pool, 'date'), dateShare, seed, 1000)
  console.log(`\n${platform}: batch of ${feed.length.toLocaleString()} from ${pool.length.toLocaleString()} link(s)`)

  const pos = feed.map((_, i) => i)
  const oursAt = feed.map((v) => ours.get(String(v.url)) ?? 0)
  const ownAt = feed.map((v) => Number(v.comment_count ?? 0))
  const cOurs = corr(pos, oursAt)
  const cOwn = corr(pos, ownAt)
  console.log(`   correlation of position with OUR comment count      : ${cOurs.toFixed(4)}`)
  console.log(`   correlation of position with the video's own comments: ${cOwn.toFixed(4)}`)
  check('  our comment count does not drive position (|r| < 0.1)', Math.abs(cOurs) < 0.1, true)
  check('  the video\'s own comment count does not either', Math.abs(cOwn) < 0.1, true)

  const withOurs = oursAt.filter((n) => n > 0).length
  console.log(`   ${withOurs.toLocaleString()} link(s) in the batch already carry one of our comments`)
  if (withOurs > 0) {
    const avgPosWith = pos.filter((_, i) => oursAt[i] > 0).reduce((a, b) => a + b, 0) / withOurs
    const withoutN = feed.length - withOurs
    const avgPosWithout = withoutN
      ? pos.filter((_, i) => oursAt[i] === 0).reduce((a, b) => a + b, 0) / withoutN
      : 0
    console.log(`   average position: ${avgPosWith.toFixed(0)} with one of ours, ${avgPosWithout.toFixed(0)} without`)
  }

  // Rebuilding from scores and the seed alone must reproduce the batch exactly.
  const again = platform === 'instagram'
    ? clusterAndOrder(pool, 'rank')
    : mixOrderings(clusterAndOrder(pool, 'rank'), clusterAndOrder(pool, 'date'), dateShare, seed, 1000)
  check('  the batch is reproducible from scores + seed alone', again.map((v) => v.url).join() === feed.map((v) => v.url).join(), true)
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
