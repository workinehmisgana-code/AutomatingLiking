// Does sorting by unrelated reports order the links the way the page claims?
//
// The count is a badge next to the URL, not a column, so the sort is the only
// way to find the links people have reported most — which is the whole point of
// the "Marked unrelated only" view: deciding what to block.
//
// Checked against the REAL reports in the database, not made-up numbers, because
// the interesting part is the shape of the data: how many links have more than
// one report at all, and whether ties leave the order stable.
//
//   node scripts/check-unrelated-sort.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (s, p = []) => (await pool.query(s, p)).rows

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

// Mirrors sortAdminLinks for the unrelated column.
const sortByUnrelated = (rows, dir) =>
  [...rows].sort((a, b) => (a.unrelated - b.unrelated) * (dir === 'asc' ? 1 : -1))

console.log('the ordering:')
const toy = [
  { url: 'a', unrelated: 1 }, { url: 'b', unrelated: 9 },
  { url: 'c', unrelated: 0 }, { url: 'd', unrelated: 4 },
]
check('desc puts the most-reported first',
  sortByUnrelated(toy, 'desc').map((l) => l.url), ['b', 'd', 'a', 'c'])
check('asc reverses it', sortByUnrelated(toy, 'asc').map((l) => l.url), ['c', 'a', 'd', 'b'])
// Array.sort is stable, so equal counts keep the order the cluster gave them.
const tied = [{ url: 'x', unrelated: 2 }, { url: 'y', unrelated: 2 }, { url: 'z', unrelated: 2 }]
check('ties keep their existing order', sortByUnrelated(tied, 'desc').map((l) => l.url), ['x', 'y', 'z'])

// ── the real reports ────────────────────────────────────────────────────────
const rows = await q(
  `SELECT url, COUNT(DISTINCT user_id)::int AS n FROM unrelated_link GROUP BY url ORDER BY n DESC`
)
const total = rows.reduce((a, r) => a + r.n, 0)
console.log(
  `\nthe real data: ${rows.length.toLocaleString()} flagged link(s), ` +
    `${total.toLocaleString()} report(s) in total`
)
const hist = {}
for (const r of rows) hist[r.n] = (hist[r.n] ?? 0) + 1
for (const [n, c] of Object.entries(hist).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 6)) {
  console.log(`   ${String(c).padStart(5)} link(s) with ${n} report(s)`)
}
const sorted = sortByUnrelated(rows.map((r) => ({ url: r.url, unrelated: r.n })), 'desc')
check('the real set sorts without losing a row', sorted.length, rows.length)
check('and the first is the most reported', sorted[0].unrelated, Math.max(...rows.map((r) => r.n)))
const descending = sorted.every((r, i) => i === 0 || r.unrelated <= sorted[i - 1].unrelated)
check('every step goes down, never up', descending, true)
if (rows.length) {
  console.log('\n   most-reported links:')
  for (const r of sorted.slice(0, 5)) console.log(`     ${String(r.unrelated).padStart(3)}  ${r.url.slice(0, 66)}`)
}
// A sort is only worth having if the values differ.
const distinct = new Set(rows.map((r) => r.n)).size
check('there is more than one distinct count to sort by', distinct > 1, true)

await pool.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
