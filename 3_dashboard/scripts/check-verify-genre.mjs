// The genre of a staged link: stored, filtered, and actually read back.
//
// verify_link.genre decides which product's comments can ever be served on a
// link once it is merged, so it is the one field on the staging list that is not
// cosmetic. It is also the field that was quietly broken: the column was
// written on insert and read by verifyMerge, but NONE of the three read queries
// listed it in their SELECT, so mapVerifyRow's isGenre() fallback fired on every
// row and every staged link came back as the default. The badge on the page
// always said Humanizer whatever the channel was added as, and merging a cocodly
// channel would have filed its videos into the humanizer pool -- the exact thing
// the column exists to prevent.
//
// A missing column in a SELECT list cannot fail loudly: the fallback makes it
// look like data. So this checks the round trip rather than the code.
//
//   node scripts/check-verify-genre.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const cfg = readFileSync(new URL('../lib/config.ts', import.meta.url), 'utf8')
const GENRES = (cfg.match(/export const GENRES = \[([\s\S]*?)\]/)?.[1] ?? '')
  .match(/'(\w+)'/g)
  ?.map((q) => q.slice(1, -1)) ?? []
const DEFAULT_GENRE = cfg.match(/export const DEFAULT_GENRE: Genre = '(\w+)'/)?.[1] ?? 'humanizer'

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
  console.log(`genres: ${GENRES.join(', ')} (default ${DEFAULT_GENRE})`)

  // ── what is actually staged, per genre ───────────────────────────────────
  const counts = await db.query(
    `SELECT COALESCE(NULLIF(genre, ''), $1) AS g, COUNT(*)::int AS n
       FROM verify_link GROUP BY 1 ORDER BY 2 DESC`,
    [DEFAULT_GENRE]
  )
  const total = counts.rows.reduce((n, r) => n + r.n, 0)
  console.log(`\n${total.toLocaleString()} staged links:`)
  for (const r of counts.rows) {
    console.log(`  ${r.g.padEnd(12)} ${r.n.toLocaleString().padStart(8)}`)
  }
  const nulls = (
    await db.query(`SELECT COUNT(*)::int AS n FROM verify_link WHERE genre IS NULL OR genre = ''`)
  ).rows[0].n
  console.log(`  (${nulls.toLocaleString()} of them hold no genre and read as ${DEFAULT_GENRE})`)

  // The hand-added channels are where a non-default genre comes from at all.
  const chans = await db.query(
    `SELECT COALESCE(NULLIF(genre, ''), $1) AS g, COUNT(*)::int AS n
       FROM extra_channel GROUP BY 1 ORDER BY 2 DESC`,
    [DEFAULT_GENRE]
  )
  console.log('\nhand-added channels, per genre:')
  for (const r of chans.rows) console.log(`  ${r.g.padEnd(12)} ${r.n.toLocaleString().padStart(8)}`)

  // ── the read queries must LIST the column ────────────────────────────────
  //
  // The regression this file exists for. mapVerifyRow coalesces a missing genre
  // to the default, which is right for an old row and catastrophic for a row
  // whose genre simply was not selected -- so the only way to tell the two
  // apart is to insist every query that feeds mapVerifyRow names the column.
  const dbSrc = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8')
  const selects = dbSrc.match(/SELECT url, account, platform[^`]*?FROM verify_link/g) ?? []
  console.log('\nevery query that feeds mapVerifyRow names the genre column:')
  check('three such queries found', selects.length, 3)
  for (const [i, q] of selects.entries()) {
    check(`  query ${i + 1} selects genre`, /\bgenre\b/.test(q.split('FROM')[0]), true)
  }

  // ── the filter finds NULL-genre rows ────────────────────────────────────
  //
  // Filtering on the default genre must return the rows that predate the column
  // too, or the filter hides most of the list while looking like it worked.
  console.log(`\nfiltering on ${DEFAULT_GENRE} includes the rows that predate the column:`)
  const filtered = await db.query(
    `SELECT COUNT(*)::int AS n FROM verify_link
      WHERE COALESCE(NULLIF(genre, ''), $1) = $1`,
    [DEFAULT_GENRE]
  )
  const expected = counts.rows.find((r) => r.g === DEFAULT_GENRE)?.n ?? 0
  check(`${DEFAULT_GENRE} filter returns every ${DEFAULT_GENRE} row`, filtered.rows[0].n, expected)
  check('which is at least the rows holding no genre', filtered.rows[0].n >= nulls, true)

  // And the predicate in the code is the coalesced one, not a raw comparison.
  const where = dbSrc.match(/function verifyWhere[\s\S]*?\n}/)?.[0] ?? ''
  check(
    'the predicate coalesces rather than comparing genre raw',
    /COALESCE\(NULLIF\(genre, ''\)/.test(where),
    true
  )

  // ── every stored genre is a real one ────────────────────────────────────
  const unknown = await db.query(
    `SELECT DISTINCT genre FROM verify_link
      WHERE genre IS NOT NULL AND genre <> '' AND NOT (genre = ANY($1::text[]))`,
    [GENRES]
  )
  console.log('\nnothing is filed under a genre that does not exist:')
  check('no unknown genre on a staged link', unknown.rows.map((r) => r.genre).join(','), '')

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n')
  process.exitCode = failures ? 1 : 0
} finally {
  await db.end()
}
