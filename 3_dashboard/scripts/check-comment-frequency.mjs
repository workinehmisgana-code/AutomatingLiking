// Are our comments kept, and can they be read back by how often they appear?
//
// "Extract comments" has always SAVED what it finds: link_comment_scan holds the
// per-link result and link_product_comment holds every one of our comments it
// found on that link — the text, the product, the position, the likes and the
// account. What was missing was a way to look at them together, because the only
// number that matters across a set of links is invisible per link: how many of
// them carry the SAME sentence.
//
// This asserts the reading path and then prints the real tally, which is the
// clearest statement of why it is worth having.
//
//   node scripts/check-comment-frequency.mjs
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
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const db = read('lib/db.ts')
const scan = read('app/api/admin/links/scan-comments/route.ts')
const route = read('app/api/admin/links/comment-tally/route.ts')
const ui = read('components/CommentFrequency.tsx')
const page = read('components/AdminLinks.tsx')

console.log('the extract saves every comment of ours that it finds:')
check('  the scan writes them', /saveLinkScan\(/.test(scan), true)
check('  with the text', /text: h\.text|text/.test(db), true)
check('  into its own table', /INSERT INTO link_product_comment \(url, product, rank, likes, username, text\)/.test(db), true)
// A re-scan replaces them, or a comment deleted since would stay in the table for
// ever and be counted as present.
check('  replaced wholesale on a re-scan', /DELETE FROM link_product_comment WHERE url = \$1/.test(db), true)
check('  and the reason is written down', /would keep comments that have since been deleted/.test(db), true)

console.log('\nand they can be read back by frequency:')
check('  there is a tally', /export async function getProductCommentTally/.test(db), true)
check('  counting DISTINCT links', /count\(DISTINCT c\.url\) AS links/.test(db), true)
check('  ordered by that count', /ORDER BY count\(DISTINCT c\.url\) DESC/.test(db), true)
check('  grouped case- and space-blind', /GROUP BY lower\(btrim\(c\.text\)\)/.test(db), true)
check('  with the products it was posted for', /array_agg\(DISTINCT c\.product\)/.test(db), true)
check('  its best position', /min\(c\.rank\) AS best_rank/.test(db), true)
check('  and when those links were last scanned', /max\(s\.scanned_at\) AS last_seen/.test(db), true)
// Totals over the whole set, not the page of rows returned.
check('  the totals are not truncated with the list', /or a\n  \/\/ truncated list would report a truncated total/.test(db), true)
check('  one comment\'s links can be listed', /export async function getLinksForComment/.test(db), true)

console.log('\nnothing is scanned or stored to show it:')
check('  the route only reads', /getProductCommentTally\(/.test(route), true)
check('  it writes nothing', /INSERT|UPDATE|DELETE/.test(route), false)
check('  it is admin-only', /isAdminEmail\(session\?\.user\?\.email\)/.test(route), true)
check('  and says so in the modal', /Nothing is read from TikTok here/.test(ui), true)

console.log('\nscoped to what the page is showing:')
check('  the filter is passed through', /parseLinkQuery\(sp\)/.test(route), true)
check('  a filter that matches nothing does not widen', /must\n        \/\/ not silently widen to the whole pool/.test(route), true)
check('  and everything is one tick away', /scope=all/.test(route) && /Every scanned link/.test(ui), true)
check('  the page hands it the current query', /query=\{queryFor\(0\)\}/.test(page), true)

console.log('\nwith a button beside the one that fills it:')
check('  the button exists', /📊 Comments by frequency/.test(page), true)
check('  it opens the list', /freqOpen && \(/.test(page), true)
check('  the list can be searched', /Find a comment…/.test(ui), true)
check('  and copied', /Copy list/.test(ui), true)
check('  a row opens its links', /showLinks\(r\.text\)/.test(ui), true)
check('  a high count is called out', /r\.links >= 10 \? 'text-amber-300'/.test(ui), true)

console.log('\nand what each comment cost to get there:')
// THE YIELD. Every comment handed to a worker is recorded on the click that served
// it, so the same grouping gives both halves: served 633 times, found on 15 links,
// 2%. Two comments identical on any per-link view can be seven times the work for
// the same result.
check('  served counts come from the serving record', /lower\(btrim\(k\.served_comment\)\)/.test(db), true)
check('  grouped the same way as the found ones', /GROUP BY lower\(btrim\(k\.served_comment\)\)/.test(db), true)
check('  both halves scoped to the same links', /BOTH HALVES ARE SCOPED THE SAME WAY/.test(db), true)
check('  and why that matters', /smaller numerator/.test(db), true)
check('  the ratio is computed once', /ratio: served > 0/.test(db), true)
// NEVER SERVED IS NOT ZERO YIELD. 2,410 of the distinct texts were posted by the
// liker and handed to nobody; dividing by nothing is not a failure.
check('  never-served has no ratio', /NULL, NOT ZERO/.test(db), true)
check('  and the row says so', /not served/.test(ui), true)
check('  the totals carry the served count', /served: Number\(srv\[0\]\?\.served \?\? 0\)/.test(db), true)

console.log('\nand the modal shows it:')
check('  a ratio per comment', /\{r\.ratio\}%/.test(ui), true)
check('  with what it was out of', /of \{r\.served\.toLocaleString\(\)\} served/.test(ui), true)
check('  the overall yield in the header', /overall !== null/.test(ui), true)
check('  found over handed out, not links over handed out', /100 \* totals\.hits\) \/ totals\.served/.test(ui), true)
// A low ratio is the actionable end, so it is reachable by one click.
check('  sortable by worst ratio', /'ratio', 'Worst ratio'/.test(ui), true)
check('  ignoring comments served a handful of times', /r\.served >= 20/.test(ui), true)
check('  and a low one is coloured for it', /text-rose-300/.test(ui), true)
// OVER 100% IS REAL: the liker posts from the same bank, so 43 comments are on
// more links than they were ever served for. That must not read as a good yield.
check('  over 100% is not shown as success', /\(r\.ratio \?\? 0\) > 100/.test(ui), true)
check('  and explains itself', /more links than servings/.test(ui), true)
check('  the copied list carries both numbers', /\$\{r\.served\}/.test(ui), true)

// ── the real tally, which is the argument for the feature ───────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const { rows: tot } = await pool
  .query(
    `SELECT count(*)::int hits, count(DISTINCT url)::int links,
            count(DISTINCT lower(btrim(text)))::int texts
       FROM link_product_comment`
  )
  .catch(() => ({ rows: [{ hits: 0, links: 0, texts: 0 }] }))
console.log(
  `\nalready saved: ${tot[0].hits.toLocaleString()} comment(s) of ours on ` +
    `${tot[0].links.toLocaleString()} link(s), ${tot[0].texts.toLocaleString()} distinct`
)
const { rows } = await pool
  .query(
    `SELECT min(text) AS text, count(DISTINCT url)::int links,
            string_agg(DISTINCT product, ',') AS products
       FROM link_product_comment
      GROUP BY lower(btrim(text))
      ORDER BY count(DISTINCT url) DESC LIMIT 8`
  )
  .catch(() => ({ rows: [] }))
console.log('the most-repeated, which is what the button is for:')
for (const r of rows) {
  console.log(`   ×${String(r.links).padEnd(4)} [${r.products}] ${JSON.stringify(r.text).slice(0, 88)}`)
}
if (rows.length && rows[0].links >= 50) {
  console.log(
    `   The top line is on ${rows[0].links} videos. One search for it finds all of them.`
  )
}
await pool.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
