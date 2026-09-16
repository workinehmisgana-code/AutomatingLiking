// The platform filter on "Links to verify".
//
// It filters on the URL, not on the stored `platform` column. That column is
// whatever the uploader or scraper wrote, and it has been wrong before: 504
// pool rows were Instagram links labelled tiktok, which is how Instagram links
// reached the search-rank clusters at all. A filter built on it would hide the
// very rows an admin goes looking for.
//
// Checked here, against the live verify list:
//
//   * the SQL buckets every row exactly as lib/config's platformFromUrl does;
//   * the counts add up to the whole list, so no row is unreachable;
//   * the filter narrows the page AND the total together, so the number beside
//     "Links to verify" keeps describing the rows under it.
//
//   node scripts/check-verify-platform.mjs
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

// The rule the rest of the app uses, copied from lib/config.ts.
const platformFromUrl = (url) => {
  const u = String(url ?? '').toLowerCase()
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('youtube.com') || u.includes('youtu.be')) {
    return u.includes('/shorts/') ? 'youtube_shorts' : 'youtube_videos'
  }
  return 'tiktok'
}

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

// Exactly the expression lib/db.ts uses, so this tests the shipped SQL rather
// than a paraphrase of it.
const SQL = read('lib/db.ts')
  .slice(read('lib/db.ts').indexOf('const VERIFY_PLATFORM_SQL = `') + 'const VERIFY_PLATFORM_SQL = `'.length)
  .split('`')[0]

try {
  console.log('the SQL agrees with platformFromUrl on every row in the list:')
  const rows = await q(`SELECT url, ${SQL} AS p FROM verify_link`)
  const wrong = rows.filter((r) => r.p !== platformFromUrl(r.url))
  check(`  ${rows.length.toLocaleString()} row(s) checked`, wrong.length, 0)
  if (wrong.length) console.log('   e.g.', wrong.slice(0, 3).map((r) => `${r.url} -> ${r.p}`))

  console.log('\nthe counts cover the whole list — no row is unreachable:')
  const counts = Object.fromEntries(
    (await q(`SELECT ${SQL} AS p, COUNT(*)::int AS n FROM verify_link GROUP BY 1`)).map((r) => [r.p, r.n])
  )
  const total = Number((await q('SELECT COUNT(*)::int AS n FROM verify_link'))[0].n)
  const summed = Object.values(counts).reduce((a, b) => a + b, 0)
  check('  every platform sums to the total', summed, total)
  for (const [p, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]))
    console.log(`   ${p.padEnd(16)} ${n.toLocaleString()}`)

  console.log('\nfiltering narrows the page and the total together:')
  for (const p of Object.keys(counts)) {
    const n = Number(
      (await q(`SELECT COUNT(*)::int AS n FROM verify_link WHERE ${SQL} = $1`, [p]))[0].n
    )
    check(`  ${p}`, n, counts[p])
  }
  const bogus = Number(
    (await q(`SELECT COUNT(*)::int AS n FROM verify_link WHERE ${SQL} = $1`, ['nonsense']))[0].n
  )
  check('  an unknown platform matches nothing', bogus, 0)
} finally {
  await db.end()
}

// ── the wiring ─────────────────────────────────────────────────────────────
const dbSrc = read('lib/db.ts')
const route = read('app/api/admin/verify-links/route.ts')
const ui = read('components/VerifyLinks.tsx')

console.log('\nit is applied server-side, where the totals are computed:')
check('  the predicate takes a platform', /platform = ''\s*\n\): \{ predicate: string/.test(dbSrc), true)
check('  getVerifyLinks passes it through', /verifyWhere\(filter, accounts, platform\)/.test(dbSrc), true)
check('  the route validates it', /CLICK_PLATFORMS\.includes\(platformParam/.test(route), true)
check('  and sends the counts', /getVerifyPlatformCounts\(\)/.test(route), true)

console.log('\nand the page tells the truth about what it is hiding:')
check('  the control exists', /onChange=\{\(e\) => changePlatform\(e\.target\.value\)\}/.test(ui), true)
check('  it resets to the first page', /function changePlatform[\s\S]{0,120}setPage\(0\)/.test(ui), true)
check('  the heading names the filter', /platform && ` on \$\{CLICK_PLATFORM_LABELS\[platform\]/.test(ui), true)
check("  'Clean the WHOLE list' warns about it", /\[platform && 'Platform', titleFilter !== 'all' && 'Title'\]/.test(ui), true)
check('  an empty platform is offered but disabled', /disabled=\{n === 0 && platform !== k\}/.test(ui), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
