// Read-only: which product is each link currently advertising?
//
// The serving order is now purifytext -> acoustictext -> prohumanly -> humlexic
// -> tintfolio -> kinprose: a link takes the first of those it does not already
// carry. This shows what the previous least-served rotation produced, and how
// many links have room left in the order.
//
//   node scripts/check-product-spread.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of envText.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const PRIORITY = ['purifytext', 'acoustictext', 'prohumanly', 'humlexic', 'tintfolio', 'kinprose']

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, params = []) => (await pool.query(sql, params)).rows

const served = await q(
  `SELECT product, COUNT(*)::int AS n, COUNT(DISTINCT url)::int AS links
     FROM clicked_link
    WHERE product IS NOT NULL AND product <> ''
    GROUP BY product`
)
const byName = new Map(served.map((r) => [r.product, r]))
const total = served.reduce((a, r) => a + r.n, 0)

console.log('comments served so far, in the new priority order:\n')
console.log(`   ${'product'.padEnd(14)} ${'served'.padStart(8)} ${'share'.padStart(7)} ${'links'.padStart(8)}`)
for (const p of PRIORITY) {
  const r = byName.get(p)
  const n = r?.n ?? 0
  console.log(
    `   ${p.padEnd(14)} ${String(n).padStart(8)} ${((100 * n) / (total || 1)).toFixed(1).padStart(6)}% ${String(r?.links ?? 0).padStart(8)}`
  )
}
for (const r of served) {
  if (!PRIORITY.includes(r.product)) {
    console.log(`   ${(r.product + ' (?)').padEnd(14)} ${String(r.n).padStart(8)}   not in the priority list`)
  }
}

// How far down the order each link has already got — i.e. what it would be
// served next.
const rows = await q(
  `SELECT url, array_agg(DISTINCT product) AS products
     FROM (
       SELECT url, product FROM clicked_link WHERE product IS NOT NULL AND product <> ''
       UNION
       SELECT url, product FROM link_product_comment
     ) x
    GROUP BY url`
)
const nextUp = new Map(PRIORITY.map((p) => [p, 0]))
let saturated = 0
for (const r of rows) {
  const has = new Set(r.products)
  const next = PRIORITY.find((p) => !has.has(p))
  if (next) nextUp.set(next, nextUp.get(next) + 1)
  else saturated++
}
console.log(`\nof ${rows.length} links that carry at least one product, what comes next:\n`)
for (const p of PRIORITY) {
  console.log(`   ${p.padEnd(14)} ${String(nextUp.get(p)).padStart(8)} link(s)`)
}
console.log(`   ${'(saturated)'.padEnd(14)} ${String(saturated).padStart(8)} link(s) carry all six`)

await pool.end()
