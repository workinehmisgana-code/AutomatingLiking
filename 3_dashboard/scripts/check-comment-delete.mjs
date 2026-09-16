// Deleting one comment removes that comment — and nothing else.
//
// Two things have to hold, and both are easy to get wrong:
//
//   * BY TEXT, not by position. The page can be a regeneration behind the
//     stored set, and deleting "number 7" would drop whatever is seventh now.
//   * generated_at is NOT touched. It drives the refresh schedule, and
//     saveGeneratedComments resets it — routing a delete through that would
//     make removing one line look like a full regeneration.
//
// Runs against the real database on a throwaway product row, then cleans up.
//
//   node scripts/check-comment-delete.mjs
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

const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

// A name no real product uses, so a failed run cannot touch a live set.
const TEST = '__delete_check__'
const SET = ['keep one', 'delete me', 'keep two', 'delete me']

/** Mirrors deleteGeneratedComment in lib/db.ts. */
const deleteOne = async (product, text) => {
  const { rows } = await db.query('SELECT comments FROM generated_comments WHERE product = $1', [product])
  const before = Array.isArray(rows[0]?.comments) ? rows[0].comments : []
  const after = before.filter((c) => String(c) !== text)
  if (after.length === before.length) return 0
  await db.query('UPDATE generated_comments SET comments = $2::jsonb WHERE product = $1', [
    product,
    JSON.stringify(after),
  ])
  return before.length - after.length
}

try {
  await db.query(
    `INSERT INTO generated_comments (product, comments, generated_at)
     VALUES ($1, $2::jsonb, now() - interval '3 days')
     ON CONFLICT (product) DO UPDATE SET comments = EXCLUDED.comments, generated_at = EXCLUDED.generated_at`,
    [TEST, JSON.stringify(SET)]
  )
  const stampBefore = (await db.query('SELECT generated_at FROM generated_comments WHERE product = $1', [TEST]))
    .rows[0].generated_at

  console.log('a set of 4, two of them identical:')
  const removed = await deleteOne(TEST, 'delete me')
  const after = (await db.query('SELECT comments, generated_at FROM generated_comments WHERE product = $1', [TEST]))
    .rows[0]
  check('  both copies of the deleted line are gone', removed, 2)
  check('  the rest survive, in order', after.comments, ['keep one', 'keep two'])
  check('  generated_at is untouched', String(after.generated_at) === String(stampBefore), true)

  console.log('\ndeleting something that is no longer there:')
  const again = await deleteOne(TEST, 'delete me')
  check('  removes nothing and says so', again, 0)
  const unchanged = (await db.query('SELECT comments FROM generated_comments WHERE product = $1', [TEST])).rows[0]
  check('  and changes nothing', unchanged.comments, ['keep one', 'keep two'])

  console.log('\na line that differs by one character is a different line:')
  check('  "keep one " (trailing space) matches nothing', await deleteOne(TEST, 'keep one '), 0)
  check('  "Keep one" (capital) matches nothing', await deleteOne(TEST, 'Keep one'), 0)
  const still = (await db.query('SELECT comments FROM generated_comments WHERE product = $1', [TEST])).rows[0]
  check('  both survive', still.comments, ['keep one', 'keep two'])
} finally {
  await db.query('DELETE FROM generated_comments WHERE product = $1', [TEST])
  await db.end()
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
