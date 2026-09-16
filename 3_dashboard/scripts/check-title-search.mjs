// The Links page search box matches the video's TITLE too.
//
// It used to match the URL and the scraped keyword only. Neither says what a
// video is ABOUT — a URL is an id, a keyword is what we searched for, not what
// came back — while the title is sitting in the Title column being read. Typing
// a phrase from it and getting nothing back was the search failing at the one
// job it looked like it did.
//
// Checked here: the predicate itself, run over the real titles, and the two
// edge cases that decide whether it can be trusted —
//
//   * a link with NO title must not start matching everything;
//   * the search must stay case-insensitive across all three fields.
//
//   node scripts/check-title-search.mjs
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

// The predicate as filterAdminLinks applies it.
const matches = (l, raw) => {
  const needle = (raw ?? '').toLowerCase().trim()
  if (!needle) return true
  return (
    l.url.toLowerCase().includes(needle) ||
    l.search_query.toLowerCase().includes(needle) ||
    l.title.toLowerCase().includes(needle)
  )
}

const row = (o = {}) => ({ url: '', search_query: '', title: '', ...o })

console.log('all three fields are searched:')
check('  the url', matches(row({ url: 'https://tiktok.com/@ab/video/1' }), 'ab'), true)
check('  the keyword', matches(row({ search_query: 'ai humanizer' }), 'humanizer'), true)
check('  the title', matches(row({ title: 'how i beat Turnitin' }), 'turnitin'), true)
check('  and a miss is still a miss', matches(row({ title: 'cooking video' }), 'turnitin'), false)

console.log('\ncase does not matter, in any of them:')
check('  TITLE vs title', matches(row({ title: 'BEAT TURNITIN' }), 'turnitin'), true)
check('  needle vs field', matches(row({ title: 'beat turnitin' }), 'TURNITIN'), true)

console.log('\na link with no title does not suddenly match everything:')
// ''.includes('x') is false, but ''.includes('') is TRUE — so an untitled link
// would match an empty needle if the blank search were not short-circuited.
check('  untitled, real needle', matches(row(), 'turnitin'), false)
check('  untitled, blank needle shows everything', matches(row(), '   '), true)
check('  titled, blank needle too', matches(row({ title: 'x' }), ''), true)

// ── against the real titles ────────────────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

try {
  const total = Number((await q('SELECT COUNT(*)::int n FROM link_title'))[0].n)
  console.log(`\nover the ${total.toLocaleString()} stored titles:`)
  for (const needle of ['turnitin', 'gptzero', 'undetectable']) {
    const rows = await q('SELECT url, title FROM link_title WHERE lower(title) LIKE $1 LIMIT 500', [
      `%${needle}%`,
    ])
    const hit = rows.filter((r) => matches(row({ url: r.url, title: r.title }), needle)).length
    check(`  every "${needle}" title matches (${rows.length} sampled)`, hit, rows.length)
  }
  // And the reverse: titles that do NOT contain the word must not match.
  const others = await q(
    "SELECT url, title FROM link_title WHERE lower(title) NOT LIKE '%turnitin%' LIMIT 500"
  )
  const wrong = others.filter(
    (r) => matches(row({ url: '', search_query: '', title: r.title }), 'turnitin')
  ).length
  check(`  and no unrelated title does (${others.length} sampled)`, wrong, 0)
} finally {
  await db.end()
}

// ── the wiring ─────────────────────────────────────────────────────────────
const lib = read('lib/adminLinks.ts')
const ui = read('components/AdminLinks.tsx')
console.log('\nthe filter and the box agree about what is searched:')
check('  the predicate includes the title', /l\.title\.toLowerCase\(\)\.includes\(needle\)/.test(lib), true)
check('  the box says so', /Filter by URL, keyword or title/.test(ui), true)
check(
  '  and warns that untitled links cannot match',
  /cannot match on it/.test(ui),
  true
)
// One predicate, so every endpoint that filters links searches the same way.
check(
  '  there is only one such predicate',
  (lib.match(/l\.title\.toLowerCase\(\)\.includes\(needle\)/g) ?? []).length,
  1
)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
