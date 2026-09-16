// Sorting the links table by search rank.
//
// Rank is the one sortable column that is a PLACING rather than a count. Two
// ways that goes wrong if it is treated like the others:
//
//   * the header opens descending, so the first click hands back #4,312 —
//     the worst links in the table — instead of #1;
//   * a link with no rank scores 0, which sorts BETTER than #1 and fills the
//     top of the table with links that were never ranked at all.
//
// Checked here: the rule as written in the source, then the ordering itself
// against the real pool.
//
//   node scripts/check-rank-sort.mjs
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

// ── the rule, as the code states it ────────────────────────────────────────
const lib = read('lib/adminLinks.ts')
const ui = read('components/AdminLinks.tsx')
const route = read('app/api/admin/links/list/route.ts')

console.log('the column is sortable end to end:')
check('  the header is a sort button', /onClick=\{\(\) => cycleSort\('rank'\)\}/.test(ui), true)
check('  it shows the direction arrow', /Rank \/ Likes\{arrowFor\('rank'\)\}/.test(ui), true)
check('  the api accepts it', /sortCol === 'rank'/.test(route), true)
check('  the sort implements it', /qy\.sortCol === 'rank'/.test(lib), true)

console.log('\nrank opens ascending, unlike the counting columns:')
check("  the header opens on asc", /col === 'rank' \? 'asc' : 'desc'/.test(ui), true)
check('  unranked links get a sentinel', /\? l\.search_rank\s*:\s*UNRANKED_LAST/.test(lib), true)
check(
  '  which is finite (NaN comparators scramble the order)',
  /const UNRANKED_LAST = Number\.MAX_SAFE_INTEGER/.test(lib),
  true
)

// ── the ordering, against the real pool ────────────────────────────────────
const UNRANKED_LAST = Number.MAX_SAFE_INTEGER
const val = (l) => (l.search_rank > 0 ? l.search_rank : UNRANKED_LAST)
const sortBy = (rows, dir) => [...rows].sort((a, b) => (val(a) - val(b)) * (dir === 'asc' ? 1 : -1))
// Math.min(...arr) overflows the stack somewhere past a hundred thousand
// arguments, and this pool is bigger than that.
const least = (arr) => arr.reduce((m, n) => (n < m ? n : m), Infinity)
const most = (arr) => arr.reduce((m, n) => (n > m ? n : m), -Infinity)

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const pool = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  })
).json()

const rows = pool
  .filter((v) => v?.url)
  .map((v) => ({ url: v.url, search_rank: Number(v.search_rank ?? 0) }))
const ranked = rows.filter((r) => r.search_rank > 0)
const unranked = rows.filter((r) => !(r.search_rank > 0))

console.log(`\nthe pool: ${ranked.length.toLocaleString()} ranked, ${unranked.length.toLocaleString()} with no rank`)

const asc = sortBy(rows, 'asc')
const desc = sortBy(rows, 'desc')

console.log('\nascending — the first click:')
check('  it opens on the best placing', asc[0].search_rank, least(ranked.map((r) => r.search_rank)))
check('  every ranked link comes first', asc.slice(0, ranked.length).every((r) => r.search_rank > 0), true)
check('  the unranked are all at the end', asc.slice(ranked.length).every((r) => !(r.search_rank > 0)), true)
check(
  '  and the numbers never go backwards',
  asc.slice(0, ranked.length).every((r, i, a) => i === 0 || a[i - 1].search_rank <= r.search_rank),
  true
)

console.log('\ndescending — the second click:')
check('  the unranked lead (worst of all)', desc.slice(0, unranked.length).every((r) => !(r.search_rank > 0)), true)
check('  then the worst real placing', desc[unranked.length].search_rank, most(ranked.map((r) => r.search_rank)))
check(
  '  and it is the exact reverse of ascending',
  desc.map((r) => val(r)).join() === asc.map((r) => val(r)).reverse().join(),
  true
)

console.log('\nno link outranks #1 by having no rank at all:')
const bestUnranked = least(unranked.map(val))
check('  every unranked link scores worse than every ranked one', bestUnranked > most(ranked.map(val)), true)

console.log(`\nfirst ten by rank: ${asc.slice(0, 10).map((r) => '#' + r.search_rank).join(' ')}`)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
