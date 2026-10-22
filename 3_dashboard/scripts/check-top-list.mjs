// Does "serve the top comments" serve anything, and is it wired end to end?
//
// The written bank is what somebody GENERATED for a product. This is the other
// source: the comments of ours that have actually been turning up on videos
// lately, ranked by reach (how many links carry them), by yield (how often a
// serving ends up on a link) or by half of each. With the switch on, a click for
// that product is answered from the top N of that list instead of from the bank.
//
// TWO THINGS ARE WORTH CHECKING AND THE SECOND IS THE REAL ONE:
//
//  1. The wiring — the setting reaches serveCommentForUrl, not just the page.
//  2. THE LIST IS NOT EMPTY. The ranking needs comments with a posting date
//     inside the window and, for the two ratio-based orders, at least 20
//     servings to judge a rate on. A product that fails that serves nothing from
//     here and silently falls back to the bank, which looks like the switch does
//     nothing. So this prints what each product would actually serve today.
//
//   node scripts/check-top-list.mjs
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
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const config = read('lib/config.ts')
const db = read('lib/db.ts')
const serve = read('lib/serveComment.ts')
const route = read('app/api/admin/comments/settings/route.ts')
const ui = read('components/AdminProductComments.tsx')
const page = read('app/admin/comments/[product]/page.tsx')

console.log('\nthe setting exists and is bounded')
check('  three rankings, no more', /'links' \| 'ratio' \| 'balanced'/.test(config), true)
check('  off by default', /DEFAULT_TOP_LIST[\s\S]{0,80}enabled: false/.test(config), true)
check('  20 of the last 30 days, balanced', /count: 20,\s*rank: 'balanced',\s*days: 30/.test(config), true)
check('  a count too small to vary is refused', /count: \{ min: 5, max: 200 \}/.test(config), true)
check('  and a window too short to rank on', /days: \{ min: 7, max: 365 \}/.test(config), true)
check('  anything untyped is clamped, not trusted', /clampTopList\(\s*\n?\s*v: Partial<Record<keyof TopListSetting, unknown>>/.test(config), true)

console.log('\nit is stored per product, beside the length band')
check('  four columns', (db.match(/ADD COLUMN IF NOT EXISTS top_/g) || []).length, 4)
check('  read back with the rest', /top_enabled, top_count, top_rank, top_days\n\s*FROM product_comment_setting/.test(db), true)
check('  written without touching the band', /top_enabled = EXCLUDED\.top_enabled/.test(db), true)
check('  a save recomputes the list', /invalidate\(`topComments:\$\{product\}`\)/.test(db), true)

console.log('\nthe ranking is the one the frequency modal shows')
check('  same tally, one product', /getProductCommentTally\(\{\s*\n\s*product,/.test(db), true)
check('  a ratio needs servings behind it', /const RATED = 20/.test(db), true)
check('  reach + ratio is normalised, not added raw', /0\.5 \* \(b\.links \/ maxLinks\) \+/.test(db), true)
check('  and the result is cached', /cached\(key, TTL\.scan/.test(db), true)

console.log('\nserving actually uses it')
check('  read per product, before the bank', /if \(top\.enabled\) \{/.test(serve), true)
check('  drawn at random from the top N', /pool\[Math\.floor\(Math\.random\(\) \* pool\.length\)\]/.test(serve), true)
check('  an empty list falls back rather than serving nothing', /Nothing measured yet for this product in this window/.test(serve), true)
check('  and the trade it makes is written down', /the bank is written PER\n \* AUDIENCE and the top list is not/.test(serve), true)

console.log('\nthe page can set it and see it')
check('  the setting reaches the component', /top: TopListSetting/.test(ui), true)
check('  and comes from the server, not a fetch', /top={top}/.test(page), true)
check('  the switch saves immediately', /void saveTop\(\{ topEnabled: e\.target\.checked \}\)/.test(ui), true)
check('  the boxes need Save', /void saveTop\(\{\s*\n\s*topCount: Number\(topCount\)/.test(ui), true)
// The warning used to name ONLY the stored setting, so choosing "best ratio" was
// answered with "reach + ratio" — the value being replaced — and read as though
// the new choice were already live.
check('  an unsaved box names both ends of the change', /ranked by \$\{RANK_LABEL\[savedTop\.rank\]\} → \$\{RANK_LABEL\[topRank\]\}/.test(ui), true)
check('  and only claims serving when the switch is on', /topOn[\s\S]{0,40}\? `Clicks are still answered from the top/.test(ui), true)
check('  saying so plainly when it is off', /The switch above is off, so clicks come from the written sets below/.test(ui), true)
check('  the list is labelled by what ranked it, not by the boxes', /RANK_LABEL\[topListFor\.rank\]/.test(ui), true)
check('  Preview shows a list without saving it', /Show the list these boxes describe, without saving them/.test(ui), true)
check('  the list loads on its own when it is live', /if \(top\.enabled\) void loadTopList\(top\)/.test(ui), true)
check('  an empty list says why and what happens instead', /Clicks fall back to the written sets below/.test(ui), true)
check('  the endpoint previews without enabling', /asking to SEE a list is not asking to use it/.test(route), true)
check('  and only saves the keys it was sent', /Object\.keys\(topIn\)\.length > 0/.test(route), true)

// ── what it would serve today, which is the point ───────────────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const DAYS = 30
const COUNT = 20
const RATED = 20

/** The same two halves getTopCommentsForProduct joins: reach and servings. */
async function tally(product) {
  const { rows } = await pool.query(
    `WITH served AS (
       SELECT lower(btrim(k.served_comment)) AS key, count(*)::int n
         FROM clicked_link k
        WHERE k.served_comment IS NOT NULL AND btrim(k.served_comment) <> ''
          AND k.clicked_at >= now() - interval '${DAYS} days'
        GROUP BY lower(btrim(k.served_comment))
     )
     SELECT min(c.text) AS text,
            count(DISTINCT c.url)::int AS links,
            coalesce(max(v.n), 0)::int AS served
       FROM link_product_comment c
       LEFT JOIN served v ON v.key = lower(btrim(c.text))
      WHERE c.product = $1 AND c.posted_at >= now() - interval '${DAYS} days'
      GROUP BY lower(btrim(c.text))
      ORDER BY count(DISTINCT c.url) DESC
      LIMIT 1000`,
    [product]
  )
  return rows.map((r) => ({
    text: r.text,
    links: r.links,
    served: r.served,
    ratio: r.served > 0 ? Math.round((100 * r.links) / r.served) : null,
  }))
}

function rank(rows, how) {
  const rated = rows.filter((r) => r.served >= RATED && r.ratio !== null)
  const maxLinks = Math.max(1, ...rated.map((r) => r.links))
  const maxPct = Math.max(1, ...rated.map((r) => r.ratio ?? 0))
  if (how === 'links') return rows.slice().sort((a, b) => b.links - a.links).slice(0, COUNT)
  return rated
    .slice()
    .sort((a, b) =>
      how === 'ratio'
        ? (b.ratio ?? 0) - (a.ratio ?? 0) || b.links - a.links
        : 0.5 * (b.links / maxLinks) +
          0.5 * ((b.ratio ?? 0) / maxPct) -
          (0.5 * (a.links / maxLinks) + 0.5 * ((a.ratio ?? 0) / maxPct))
    )
    .slice(0, COUNT)
}

const { rows: products } = await pool.query(
  `SELECT product, top_enabled, top_count, top_rank, top_days
     FROM product_comment_setting ORDER BY product`
)
console.log(`\nwhat each product would serve today (last ${DAYS} days, top ${COUNT})`)
let anyEmpty = 0
for (const p of products) {
  const rows = await tally(p.product)
  const by = { balanced: rank(rows, 'balanced'), ratio: rank(rows, 'ratio'), links: rank(rows, 'links') }
  const state = p.top_enabled ? `ON  ${p.top_rank}/${p.top_days}d/${p.top_count}` : 'off'
  console.log(
    `\n  ${p.product} [${state}] — ${rows.length} dated comment(s) in the window, ` +
      `${by.balanced.length} rankable by reach+ratio, ${by.links.length} by links`
  )
  if (by.balanced.length === 0) anyEmpty++
  for (const r of by.balanced.slice(0, 5)) {
    console.log(
      `     ${String(r.links).padStart(4)} links  ${String(r.ratio ?? '-').padStart(3)}%  ` +
        `${String(r.served).padStart(4)} served  ${r.text.slice(0, 64)}`
    )
  }
  if (by.balanced.length === 0 && by.links.length > 0) {
    console.log(
      `     nothing has ${RATED}+ servings in the window, so reach+ratio and ratio are ` +
        `empty here; "most links" would still serve ${by.links.length}.`
    )
  }
}
if (anyEmpty > 0) {
  console.log(
    `\nnote: ${anyEmpty} product(s) would fall back to the written bank on the two ` +
      `ratio orders. That is the designed fallback, not a failure — but turning the ` +
      `switch on for them changes nothing until more dated, served comments land.`
  )
}

console.log(fails === 0 ? '\nall checks passed' : `\n${fails} check(s) FAILED`)
await pool.end()
process.exit(fails === 0 ? 0 : 1)
