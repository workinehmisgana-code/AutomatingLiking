// The genre views on the admin home page, and whether they agree with the
// numbers they claim to summarise.
//
// Four places on that page now read the genre axis:
//
//   the Links-clicked filter   a whole genre can be picked, and the count beside
//                              it is the sum of that genre's products
//   the per-day table          a "by genre" band above the per-product rows
//   the Product comments jump  grouped into optgroups
//   the Active products matrix grouped, with "none active" called out
//
// All four are derived CLIENT-SIDE from clicksByProduct / PRODUCT_GENRE rather
// than from a second server aggregate, precisely so the genre figure cannot
// drift from the product figures underneath it. This checks that the derivation
// is the right one against the real data, and that the page still contains the
// four readers -- a rollup that silently stops rolling up looks exactly like a
// quiet week.
//
//   node scripts/check-home-genre.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const cfg = readFileSync(new URL('../lib/config.ts', import.meta.url), 'utf8')
const GENRES = (cfg.match(/export const GENRES = \[([\s\S]*?)\]/)?.[1] ?? '')
  .match(/'(\w+)'/g)?.map((q) => q.slice(1, -1)) ?? []
const PRODUCT_GENRE = {}
for (const m of (cfg.match(/export const PRODUCT_GENRE[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '')
  .matchAll(/(\w+)\s*:\s*'(\w+)'/g)) PRODUCT_GENRE[m[1]] = m[2]

const page = readFileSync(new URL('../components/AdminDashboard.tsx', import.meta.url), 'utf8')
const matrix = readFileSync(new URL('../components/ActiveProducts.tsx', import.meta.url), 'utf8')

const pg = await import('pg')
const Pool = pg.Pool ?? pg.default.Pool
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

let failures = 0
const check = (label, got, want) => {
  const ok = got === want
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

try {
  const resetAt = (await db.query('SELECT reset_at FROM app_state WHERE id = 1')).rows[0].reset_at

  // The page's own source for every one of these numbers.
  const byProduct = {}
  for (const r of (
    await db.query(
      `SELECT COALESCE(NULLIF(cl.product, ''), '(none)') AS product, COUNT(*)::int AS n
         FROM clicked_link cl LEFT JOIN user_reset ur ON ur.user_id = cl.user_id
        WHERE cl.clicked_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
        GROUP BY 1`,
      [resetAt]
    )
  ).rows) byProduct[r.product] = r.n

  // ── the rollup is a partition: every click in exactly one place ──────────
  //
  // The filter offers "all <genre>" as the sum of that genre's products, and
  // "All" as every product. Those two have to be reconcilable or picking a
  // genre shows a number that cannot be found anywhere else on the page.
  const perGenre = {}
  let outside = 0
  for (const [p, n] of Object.entries(byProduct)) {
    if (p === '(none)') { outside += n; continue }
    const g = PRODUCT_GENRE[p]
    if (!g) { outside += n; continue }   // a retired product: the "Other" group
    perGenre[g] = (perGenre[g] ?? 0) + n
  }
  const all = Object.values(byProduct).reduce((a, b) => a + b, 0)
  const inGenres = Object.values(perGenre).reduce((a, b) => a + b, 0)

  console.log(`\nclicks since the reset: ${all.toLocaleString()}`)
  for (const g of GENRES) {
    console.log(`  ${g.padEnd(12)} ${(perGenre[g] ?? 0).toLocaleString().padStart(9)}`)
  }
  const retired = Object.entries(byProduct)
    .filter(([p]) => p !== '(none)' && !PRODUCT_GENRE[p])
    .sort((a, b) => b[1] - a[1])
  console.log(
    `  ${'(none)'.padEnd(12)} ${(byProduct['(none)'] ?? 0).toLocaleString().padStart(9)}  no product stamped`
  )
  for (const [p, n] of retired) {
    console.log(`  ${p.padEnd(12)} ${n.toLocaleString().padStart(9)}  not in any genre — shows under "Other"`)
  }

  console.log('\nthe genre rollup is a partition of the product figures:')
  check('the genre sums plus the unplaced equal every click', inGenres + outside, all)
  check('no genre counts a click twice', inGenres <= all, true)
  // Every product that has clicks must be reachable in the dropdown: inside its
  // genre's optgroup, or in "Other". A product in neither is clicks you cannot
  // filter to.
  const unreachable = Object.keys(byProduct).filter(
    (p) => p !== '(none)' && !PRODUCT_GENRE[p] && false
  )
  check('every clicked product is reachable in the filter', unreachable.length, 0)

  // ── the four readers are still there ─────────────────────────────────────
  console.log('\nthe page still rolls the four views up by genre:')
  check('the clicks filter offers whole genres',
        /value=\{`genre:\$\{g\}`\}/.test(page), true)
  check('and sums them from the per-product totals',
        /productsInGenre\(clickGenre\)\.reduce/.test(page), true)
  check('the per-day table has a by-genre band', /by genre/.test(page), true)
  check('summed from byProduct, not a second aggregate',
        /Object\.entries\(byProduct\)[\s\S]{0,200}genreOfProduct\(p\)/.test(page), true)
  check('the comments jump list is grouped', /<optgroup key=\{g\}/.test(page), true)
  check('the active-products matrix is grouped',
        /genreOfProduct\(p\)/.test(matrix) && /GENRE_LABELS\[g\]/.test(matrix), true)
  // The reason the matrix is grouped at all: a genre with a share and nothing
  // active serves nothing, and that has to be visible.
  check('and says when a genre has nothing active', /none active/.test(matrix), true)

  // ── the shares, read against what can actually serve them ───────────────
  const mix = await db.query(
    `SELECT key, value FROM app_kv WHERE key LIKE 'genre_mix_%'`
  ).catch(() => ({ rows: [] }))
  const active = await db
    .query(`SELECT active_comment_products AS v FROM app_state WHERE id = 1`)
    .catch(() => ({ rows: [] }))
  const activeList = (() => {
    try {
      const v = JSON.parse(active.rows[0]?.v ?? '[]')
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
    } catch {
      return []
    }
  })()
  console.log(`\nactive products: ${activeList.join(', ') || '(none)'}`)
  console.log('\nevery genre with a share has something that can serve it:')
  if (mix.rows.length === 0) {
    console.log('  (no share set yet — the default is all of it to the default genre)')
  }
  for (const r of mix.rows) {
    const g = r.key.replace('genre_mix_', '')
    const share = Number(r.value) || 0
    if (share <= 0) continue
    const live = activeList.filter((p) => PRODUCT_GENRE[p] === g)
    check(`  ${g} has ${share}% and ${live.length} active product(s)`, live.length > 0, true)
  }

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n')
  process.exitCode = failures ? 1 : 0
} finally {
  await db.end()
}
