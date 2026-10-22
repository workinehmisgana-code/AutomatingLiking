// Do a channel's links arrive together on the Links-to-verify page?
//
// A channel is judged as a whole — from its bio and what it posts — so its links
// have to sit in one run rather than being interleaved with everyone else's by
// upload time. This runs the page's real query and checks that every channel
// occupies exactly one run, on the page and across the whole list.
//
//   node scripts/check-verify-grouping.mjs
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

// ── the order the page puts them in, on top of that query ────────────────
//
// Two rules, both of which were bugs:
//
// THE ORDER MUST NOT DEPEND ON THE SELECTION. displayRows used to partition on
// `selected`, so ticking any box moved that row into the pinned block and the
// whole list re-flowed under the cursor — going to select a second link jumped
// the page to the channel's already-selected ones. Reviewing is exactly when
// somebody ticks and unticks a lot, so the order has to hold still. It is a
// frozen snapshot taken by Mark, and `selected` must not be in the deps.
//
// AND UNTITLED LINKS COME BEFORE TITLED ONES. Mark only classifies rows that
// have a title, so an untitled link has had no verdict at all and is the one
// still needing a human; mixed in among hundreds of judged rows they were
// missed.
const page = readFileSync(new URL('../components/VerifyLinks.tsx', import.meta.url), 'utf8')
// The pinned block comes from the snapshot; the untitled-first ordering is
// keyed on classifiedThisPage, which survives a block so those links stay at
// the top once the unrelated ones are gone.
const deps = /}, \[rows, pinnedUrls, classifiedThisPage\]\)/.test(page)

console.log('\nthe page order holds still while it is reviewed:')
check('  the pinned set is a frozen snapshot, not a flag',
      /const \[pinnedUrls, setPinnedUrls\] = useState<Set<string>>/.test(page), true)
check('  taken by Mark, from what it found unrelated',
      /setPinnedUrls\(new Set\(unrelated\)\)/.test(page), true)
check('  the display order depends on rows and the snapshot', deps, true)
// THE REGRESSION. If `selected` goes back into those deps, the jump returns.
check('  and NOT on the live selection',
      /}, \[rows, pinSelected, selected\]\)/.test(page) || /}, \[rows, selected\]\)/.test(page),
      false)
check('  cleared on a new page, a block and a clean',
      (page.match(/setPinnedUrls\(new Set\(\)\)/g) ?? []).length, 3)

console.log('\nand untitled links are reviewed first:')
check('  three blocks: pinned, untitled, titled',
      /return \[\.\.\.pinned, \.\.\.untitled, \.\.\.titled\]/.test(page), true)
check('  an untitled row is one with no title text',
      /else if \(!r\.title \|\| !r\.title\.trim\(\)\) untitled\.push\(r\)/.test(page), true)
// Mark can only judge a row that HAS a title - which is why the untitled ones
// are the ones left to do.
check('  because Mark only ever classified titled rows',
      /rows\.filter\(\(r\) => r\.title\)\.map/.test(page), true)

const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const PAGE = 500
/** The ORDER BY from getVerifyLinks, verbatim. */
const grouped = (limit, offset) => db.query(
  `SELECT url, account FROM (
     SELECT *, min(added_at) OVER (PARTITION BY lower(coalesce(account, ''))) AS chan_first
       FROM verify_link
   ) t
   ORDER BY chan_first, lower(coalesce(account, '')), added_at, url
   LIMIT $1 OFFSET $2`,
  [limit, offset]
)
/** What it used to be. */
const oldOrder = (limit, offset) => db.query(
  'SELECT url, account FROM verify_link ORDER BY added_at, url LIMIT $1 OFFSET $2',
  [limit, offset]
)

/** How many separate runs each channel is broken into. */
const runsOf = (rows) => {
  const runs = new Map()
  let prev = null
  for (const r of rows) {
    const k = (r.account || '').toLowerCase()
    if (k !== prev) runs.set(k, (runs.get(k) ?? 0) + 1)
    prev = k
  }
  return runs
}
const split = (rows) => Array.from(runsOf(rows).values()).filter((n) => n > 1).length

const total = (await db.query('SELECT COUNT(*)::int n FROM verify_link')).rows[0].n
const chans = (await db.query("SELECT COUNT(DISTINCT lower(coalesce(account,'')))::int n FROM verify_link")).rows[0].n
console.log(`the verify list: ${total.toLocaleString()} link(s) across ${chans.toLocaleString()} channel(s)`)

console.log('\nthe first page:')
const [g0, o0] = await Promise.all([grouped(PAGE, 0), oldOrder(PAGE, 0)])
console.log(`   grouped order : ${runsOf(g0.rows).size} channel(s) on the page, ${split(g0.rows)} broken into more than one run`)
console.log(`   old order     : ${runsOf(o0.rows).size} channel(s) on the page, ${split(o0.rows)} broken into more than one run`)
check('  no channel is split on the page', split(g0.rows), 0)

console.log('\nacross the first five pages:')
let all = []
for (let p = 0; p < 5; p++) all = all.concat((await grouped(PAGE, p * PAGE)).rows)
check('  no channel is split across pages either', split(all), 0)
console.log(`   ${all.length.toLocaleString()} row(s), ${runsOf(all).size} channel(s), largest run ${Math.max(
  ...Array.from(
    all.reduce((m, r) => {
      const k = (r.account || '').toLowerCase()
      m.set(k, (m.get(k) ?? 0) + 1)
      return m
    }, new Map()).values()
  )
)} link(s)`)

// The ordering must be stable: the same query twice must give the same page, or
// paging would show a link twice and skip another.
console.log('\nthe order is stable:')
const again = await grouped(PAGE, 0)
check('  the same page comes back identical', again.rows.map((r) => r.url).join() === g0.rows.map((r) => r.url).join(), true)

// Channels in upload order, not alphabetical — the admin works through the list
// in the order the uploads arrived.
const firstFew = []
for (const r of g0.rows) {
  const k = r.account || ''
  if (!firstFew.includes(k)) firstFew.push(k)
  if (firstFew.length >= 6) break
}
console.log('\nthe first channels on page 1, in order:')
for (const c of firstFew) console.log(`   @${c}`)
const alpha = [...firstFew].sort((a, b) => a.localeCompare(b))
console.log(
  firstFew.join() === alpha.join()
    ? '   (they happen to be alphabetical here)'
    : '   (not alphabetical — ordered by when each channel was first staged)'
)

await db.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
