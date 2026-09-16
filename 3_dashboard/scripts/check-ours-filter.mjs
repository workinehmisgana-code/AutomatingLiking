// Filtering and sorting links by which of our products are on them.
//
// Two distinct questions, and the difference matters:
//
//   "has ours"      is ANY of our comments on this video?
//   "has purifytext" is THIS one on it?
//
// The second decides what to serve next — a video already led by one product is
// meant to stay with it — so it needs its own filter rather than being folded
// into the first.
//
// The sort has one trap: a link nobody has extracted has NO count, which is not
// a count of zero. Descending order must not open with a hundred thousand
// unknowns.
//
//   node scripts/check-ours-filter.mjs
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

/** Mirrors the oursProduct clause in filterAdminLinks. */
const hasProduct = (row, product) => (row.ourComments?.[product] ?? 0) > 0
/** Mirrors the 'ours' branch of sortAdminLinks. */
const oursTotal = (row) =>
  row.ourComments === null ? -1 : Object.values(row.ourComments).reduce((a, n) => a + n, 0)

console.log('the rule, on made-up rows:')
const never = { ourComments: null }
const clean = { ourComments: {} }
const one = { ourComments: { purifytext: 3 } }
const two = { ourComments: { purifytext: 1, acoustictext: 4 } }
check('  never extracted does not match any product', hasProduct(never, 'purifytext'), false)
check('  extracted and clean does not match either', hasProduct(clean, 'purifytext'), false)
check('  a link carrying it matches', hasProduct(one, 'purifytext'), true)
check('  and does not match a different product', hasProduct(one, 'acoustictext'), false)
check('  never extracted sorts below clean, not above', oursTotal(never) < oursTotal(clean), true)
check('  totals add across products', oursTotal(two), 5)

// ── against the real pool ───────────────────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const counts = new Map()
for (const r of (await db.query(
  'SELECT url, product, COUNT(*)::int n FROM link_product_comment GROUP BY url, product'
)).rows) {
  const m = counts.get(r.url) ?? {}
  m[r.product] = r.n
  counts.set(r.url, m)
}
const scanned = new Set(
  (await db.query('SELECT DISTINCT url FROM link_comment_scan')).rows.map((r) => r.url)
)
await db.end()

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  cache: 'no-store',
})).json()

// ourComments: {} = extracted, none of ours. null = never extracted.
const rows = videos.map((v) => ({
  url: String(v.url ?? ''),
  ourComments: counts.get(String(v.url ?? '')) ?? (scanned.has(String(v.url ?? '')) ? {} : null),
}))

console.log(`\nthe pool (${rows.length.toLocaleString()} links):`)
const neverN = rows.filter((r) => r.ourComments === null).length
const cleanN = rows.filter((r) => r.ourComments && Object.keys(r.ourComments).length === 0).length
const someN = rows.filter((r) => r.ourComments && Object.keys(r.ourComments).length > 0).length
console.log(`   never extracted : ${neverN.toLocaleString()}`)
console.log(`   extracted clean : ${cleanN.toLocaleString()}`)
console.log(`   carries ours    : ${someN.toLocaleString()}`)
check('  the three states add up', neverN + cleanN + someN, rows.length)

const byProduct = {}
for (const r of rows) {
  for (const p of Object.keys(r.ourComments ?? {})) byProduct[p] = (byProduct[p] ?? 0) + 1
}
console.log('\n   links each product already sits on:')
for (const [p, n] of Object.entries(byProduct).sort((a, b) => b[1] - a[1])) {
  console.log(`     has ${p.padEnd(14)} ${n.toLocaleString()}`)
  check(`     the filter returns exactly that`, rows.filter((r) => hasProduct(r, p)).length, n)
}

console.log('\nsorted by total, descending:')
const top = [...rows].sort((a, b) => oursTotal(b) - oursTotal(a)).slice(0, 5)
for (const r of top) console.log(`   ${String(oursTotal(r)).padStart(3)} · ${r.url.slice(-28)}`)
check('  the top row is a real count, not an unknown', oursTotal(top[0]) > 0, true)
const tail = [...rows].sort((a, b) => oursTotal(b) - oursTotal(a)).slice(-1)[0]
check('  the bottom is a never-extracted link', oursTotal(tail), -1)

// ── filtering by HOW MANY ───────────────────────────────────────────────────
// A range, not just "has some". A link nobody has extracted is excluded from
// both bounds: no count is not a count of zero, and "at least 1 of ours" must
// not return the 135k links whose comment sections nobody has read.
const inRange = (row, min, max) => {
  if (row.ourComments === null) return false
  const n = Object.values(row.ourComments).reduce((a, x) => a + x, 0)
  if (min != null && n < min) return false
  if (max != null && n > max) return false
  return true
}

console.log('\nfiltering by how many of ours are on the video:')
check('  never-extracted is excluded from "at least 1"', inRange(never, 1, null), false)
check('  never-extracted is excluded from "at most 0" too', inRange(never, null, 0), false)
check('  extracted-and-clean IS "at most 0"', inRange(clean, null, 0), true)
check('  a link with 5 matches "at least 3"', inRange(two, 3, null), true)
check('  and does not match "at most 2"', inRange(two, null, 2), false)

for (const [min, max, label] of [
  [1, null, 'at least 1'],
  [3, null, 'at least 3'],
  [10, null, 'at least 10'],
  [null, 0, 'exactly none, proven'],
]) {
  const n = rows.filter((r) => inRange(r, min, max)).length
  console.log(`   ${label.padEnd(22)} ${n.toLocaleString()} link(s)`)
}
check(
  '  "at least 1" equals the carries-ours count',
  rows.filter((r) => inRange(r, 1, null)).length,
  someN
)
check(
  '  "at most 0" equals the extracted-clean count',
  rows.filter((r) => inRange(r, null, 0)).length,
  cleanN
)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
