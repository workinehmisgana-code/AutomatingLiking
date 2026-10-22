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
check('  into its own table',
      /INSERT INTO link_product_comment \(url, product, rank, likes, username, text, posted_at\)/.test(db),
      true)
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
// AND "NONE IN THIS WINDOW" IS NOT "NEVER". On a 7-day view 2,146 comments have
// no serving inside the window and 722 of those were served before it, some
// hundreds of times. One number cannot tell those apart, so the query returns
// both.
check('  the all-time count comes back too', /served_ever AS/.test(db), true)
check('  with the last date', /max\(k\.clicked_at\) AS last_at/.test(db), true)
check('  and the row says which it is', /served earlier/.test(ui) && /never served/.test(ui), true)
check('  saying how many came before the window', /before this window/.test(ui), true)
check('  and the row says so', /not served/.test(ui), true)
check('  the totals carry the served count', /served: Number\(srv\[0\]\?\.served \?\? 0\)/.test(db), true)

console.log('\nand the modal shows it:')
check('  a ratio per comment', /\{r\.ratio\}%/.test(ui), true)
check('  with what it was out of', /of \{r\.served\.toLocaleString\(\)\} served/.test(ui), true)
check('  the overall yield in the header', /overall !== null/.test(ui), true)
check('  found over handed out, not links over handed out', /100 \* totals\.hits\) \/ totals\.served/.test(ui), true)
// A low ratio is the actionable end, so it is reachable by one click.
check('  four orders to read it in', /'links', 'Most links'/.test(ui) && /'served', 'Most served'/.test(ui) &&
      /'ratio', 'Best ratio'/.test(ui) && /'balanced', 'Reach \+ ratio'/.test(ui), true)
// HALF AND HALF, each against the best in the list. The two numbers are on
// different scales — a count that runs to 208 and a percentage mostly under 30 —
// so adding them raw is a reach count with a rounding error on top.
check('  the weighted one is 50/50', /0\.5 \* \(r\.links \/ maxLinks\) \+ 0\.5 \* \(\(r\.ratio \?\? 0\) \/ maxPct\)/.test(ui), true)
check('  normalised, not added', /WHY NORMALISE RATHER THAN ADD/.test(ui), true)
check('  and the row shows its score', /reach\+ratio score/.test(ui), true)
check('  ignoring comments served a handful of times', /RATIO_MIN_SERVED = 20/.test(ui), true)
check('  and a low one is coloured for it', /text-rose-300/.test(ui), true)
// OVER 100% IS REAL: the liker posts from the same bank, so 43 comments are on
// more links than they were ever served for. That must not read as a good yield.
check('  over 100% is not shown as success', /\(r\.ratio \?\? 0\) > 100/.test(ui), true)
check('  and explains itself', /more links than servings/.test(ui), true)
check('  the copied list carries both numbers', /\$\{r\.served\}/.test(ui), true)

console.log('\nand it can be narrowed to a period:')
// BOTH HALVES OR NEITHER. Narrowing the found side to a month while the served
// side keeps a year of clicks would divide this month's findings by all of last
// year's serving and call the result a yield. Measured: over 7 days the yield
// reads 57%, all-time 24% — same links, different denominators.
check('  the tally takes a window', /days\?: number/.test(db), true)
// THE COMMENT'S OWN DATE, now that the extract keeps it: TikTok returns
// create_time on every comment and the parse used to throw it away with the other
// forty fields. Rows written before that fall back to the link's last scan, which
// is the only date there ever was.
// THE COMMENT'S OWN DATE, AND ONLY THAT. Falling back to the link's last scan
// put a comment posted on 18 August inside a 7-day window, because its link had
// been scanned yesterday — checked against the video itself. A date we do not
// have is not evidence of recency.
check('  the found side is scoped by the posting date alone',
      /if \(since\) conds\.push\(`c\.posted_at >= \$\{since\}`\)/.test(db), true)
check('  undated rows are held out, and counted', /undated: number/.test(db), true)
check('  the page says how many', /have no posting date yet and are/.test(ui), true)
// AND IT CAN FILL THEM. There is nothing to migrate — the date was never
// stored and cannot be derived from anything we hold, so it has to come from
// TikTok: the same extract, aimed at exactly the links that would gain from it.
check('  there is a button for it', /Get missing dates/.test(ui), true)
check('  driving its own endpoint', /links\/comment-dates/.test(ui), true)
check('  which reads the oldest scans first', /ORDER BY s\.scanned_at NULLS FIRST/.test(db), true)
check('  in batches, to a deadline', /BUDGET_MS/.test(read('app/api/admin/links/comment-dates/route.ts')), true)
check('  resumably', /remaining: left\.links/.test(read('app/api/admin/links/comment-dates/route.ts')), true)
check('  and stoppably', /stopDating\.current = true/.test(ui), true)
// A BAR NEEDS A LENGTH BEFORE IT STARTS, so the route answers a GET with the
// size of the job, taken over the same scope the work will use.
check('  the job is measured first', /export async function GET/.test(read('app/api/admin/links/comment-dates/route.ts')), true)
check('  over one shared scope', /async function scopeUrls/.test(read('app/api/admin/links/comment-dates/route.ts')), true)
check('  there is a bar', /dateProg\.total > 0/.test(ui), true)
check('  counted in links, not comments', /COUNTED IN LINKS, NOT COMMENTS/.test(ui), true)
check('  and it cannot run past its end', /Math\.min\(100, \(100 \* dateProg\.done\)/.test(ui), true)
// The expanded list is the evidence for the count above it, so it obeys the same
// window — it used to show every link that ever carried the text.
check('  the expansion takes the window too', /getLinksForComment\(one, 200, oneDays\)/.test(route), true)
check('  and each link shows its own date', /l\.postedAt/.test(ui), true)
check('  the reader parses create_time', /create_time\?: unknown/.test(read('lib/linkStats.ts')), true)
check('  guarded against a nonsense value', /secs > 1_000_000_000 && secs < 4_000_000_000/.test(read('lib/linkStats.ts')), true)
check('  the scan carries it', /postedAt: c\.postedAt/.test(read('lib/commentScan.ts')), true)
check('  the column exists', /ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ/.test(db), true)
check('  written by the scan', /posted_at\)\n       SELECT \$1, p, r, l, u, t, d::timestamptz/.test(db), true)
// A read that came back without a date must not erase one an earlier read got.
check('  and never erased by a dateless re-read',
      /posted_at = COALESCE\(EXCLUDED\.posted_at, link_product_comment\.posted_at\)/.test(db), true)
check('  the row shows it', /r\.lastPosted/.test(ui), true)
check('  marking the fallback as approximate', /` · ~\$\{when\(r\.lastSeen\)\}`/.test(ui), true)
check('  the served side by the click date', /k\.clicked_at >= \$\{since\}/.test(db), true)
// LEFT, not inner: a comment with its own date must not be dropped because its
// link has no scan row.
check('  the totals are scoped too',
      /\$\{since \? 'LEFT JOIN link_comment_scan s ON s\.url = c\.url' : ''\}/.test(db), true)
check('  and clamped', /Math\.min\(3650/.test(db), true)
// A comment row has no date of its own — a scan writes it, the next scan replaces
// it — so the only honest reading of "found recently" is "on a link read recently".
check('  what the window means is written down',
      /WHAT "FOUND IN THE LAST 30 DAYS" MEANS/.test(db), true)
check('  and that old rows fall back to the scan date',
      /fall back to the date their link was last\n \* scanned/.test(db), true)
check('  the route passes it', /days=N narrows both halves/.test(route), true)
check('  and reports it in the scope line', /last \$\{days\} days/.test(route), true)
check('  the modal offers the windows', /<option value=\{50\}>50 days<\/option>/.test(ui), true)
check('  refetches when it changes', /\[query, all, days, reload\]/.test(ui), true)
check('  and an empty window says why', /Nothing of ours was posted in the last/.test(ui), true)

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
