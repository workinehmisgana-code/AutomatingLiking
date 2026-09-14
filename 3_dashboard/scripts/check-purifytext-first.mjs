// Does every link get its purifytext comment before anything else?
//
// The rule: a link that does not already carry a purifytext comment is served
// one; a link that does is drawn from the active products at random.
//
// "Already carries one" has to read TWO tables and the interesting failures are
// about which:
//
//   * link_product_comment only — a scan is proof, but 94% of links have never
//     been scanned, so between serving purifytext and the next scan finding it
//     every user opening that link would be handed purifytext again. Five
//     people, five identical comments on one video.
//   * clicked_link only — misses links that already carried a purifytext
//     comment before we ever served one (someone else's, or an older run's).
//
// Runs against the real database on scratch rows, cleaned up afterwards.
//
//   node scripts/check-purifytext-first.mjs
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
const q = async (sql, p = []) => (await pool.query(sql, p)).rows

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(
    `   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
  )
}

const FIRST = 'purifytext'
const PRODUCTS = ['purifytext', 'acoustictext', 'prohumanly', 'humlexic', 'tintfolio', 'kinprose']

// Mirrors lib/db.ts linkHasProduct + pickFairProductForUrl.
async function linkHasProduct(url, product) {
  const rows = await q(
    `SELECT (
       EXISTS (SELECT 1 FROM link_product_comment WHERE url = $1 AND product = $2)
       OR
       EXISTS (SELECT 1 FROM clicked_link WHERE url = $1 AND product = $2)
     ) AS has`,
    [url, product]
  )
  return rows[0]?.has === true
}
async function pick(url, products = PRODUCTS) {
  if (products.length === 0) return null
  if (products.includes(FIRST)) {
    if (!(await linkHasProduct(url, FIRST))) return FIRST
  }
  return products[Math.floor(Math.random() * products.length)] ?? null
}

const TAG = 'https://example.invalid/purifytest/'
const A = TAG + 'never-touched'
const B = TAG + 'scanned-with-purifytext'
const C = TAG + 'served-purifytext'
const D = TAG + 'scanned-with-something-else'

const [{ id: userId }] = await q(
  `SELECT id FROM "user" LIMIT 1`
).catch(() => [{ id: null }])

try {
  console.log('a link nobody has touched:')
  check('gets purifytext', await pick(A), FIRST)
  check('and again, until one lands', await pick(A), FIRST)

  console.log('\na link a SCAN found purifytext on:')
  await q(
    `INSERT INTO link_product_comment (url, product, rank, text, likes)
     VALUES ($1, $2, 1, 'x', 0) ON CONFLICT DO NOTHING`,
    [B, FIRST]
  )
  check('it already has one', await linkHasProduct(B, FIRST), true)
  const draws = new Set()
  for (let i = 0; i < 60; i++) draws.add(await pick(B))
  check('so the draw is open to every product', draws.size > 1, true)
  check('and purifytext is still in it', draws.has(FIRST), true)

  console.log('\na link we have SERVED purifytext for but not yet scanned:')
  if (userId) {
    await q(
      `INSERT INTO clicked_link (user_id, url, product, served_comment)
       VALUES ($1, $2, $3, 'x')`,
      [userId, C, FIRST]
    )
    check('it counts as having one', await linkHasProduct(C, FIRST), true)
    const seen = new Set()
    for (let i = 0; i < 60; i++) seen.add(await pick(C))
    check('the next user is not handed purifytext again', seen.size > 1, true)
  } else {
    console.log('   (no user row to attribute a click to — skipped)')
  }

  console.log('\na link scanned and found to carry a DIFFERENT product:')
  await q(
    `INSERT INTO link_product_comment (url, product, rank, text, likes)
     VALUES ($1, 'humlexic', 1, 'x', 0) ON CONFLICT DO NOTHING`,
    [D]
  )
  check('still owed a purifytext', await linkHasProduct(D, FIRST), false)
  check('so that is what it gets', await pick(D), FIRST)

  console.log('\nwhen purifytext is switched off in the admin settings:')
  const without = PRODUCTS.filter((p) => p !== FIRST)
  const got = new Set()
  for (let i = 0; i < 40; i++) got.add(await pick(A, without))
  check('it is never served', got.has(FIRST), false)
  check('and the draw still returns something', got.size > 1, true)
  check('no products at all means null', await pick(A, []), null)
} finally {
  await q('DELETE FROM link_product_comment WHERE url LIKE $1', [TAG + '%'])
  await q('DELETE FROM clicked_link WHERE url LIKE $1', [TAG + '%'])
  console.log('\ntest rows removed.')
}

// How much of the real pool is owed a purifytext comment right now?
const [{ n: served }] = await q(
  `SELECT COUNT(DISTINCT url)::int AS n FROM clicked_link WHERE product = $1`,
  [FIRST]
)
const [{ n: scanned }] = await q(
  `SELECT COUNT(DISTINCT url)::int AS n FROM link_product_comment WHERE product = $1`,
  [FIRST]
)
console.log(
  `\nlinks that already carry purifytext: ${served.toLocaleString()} served, ` +
    `${scanned.toLocaleString()} found by a scan`
)

await pool.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
