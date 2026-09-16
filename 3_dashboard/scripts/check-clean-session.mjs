// The click record that belongs to an "only links with none of ours" session.
//
// While that setting is on, the PERMANENT click record is deliberately ignored —
// a link with none of ours is worth another go. That alone would hand the same
// link back on every fetch of the session, so a second, temporary record is kept
// and used in its place. It must:
//
//   * suppress a link for the rest of the session, once opened
//   * never touch the permanent record, which the rest of the app depends on
//   * be empty again after the setting is switched, either way
//
// Runs against the real database on a throwaway user id, then cleans up.
//
//   node scripts/check-clean-session.mjs
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

const USER = '__clean_session_check__'
const A = 'https://www.tiktok.com/@x/video/1111111111111111111'
const B = 'https://www.tiktok.com/@x/video/2222222222222222222'

const session = async () =>
  (await db.query('SELECT url FROM clean_session_click WHERE user_id = $1 ORDER BY url', [USER]))
    .rows.map((r) => r.url)
const permanent = async () =>
  (await db.query('SELECT url FROM clicked_link WHERE user_id = $1 ORDER BY url', [USER]))
    .rows.map((r) => r.url)
const note = (url) =>
  db.query(
    `INSERT INTO clean_session_click (user_id, url) VALUES ($1, $2)
     ON CONFLICT (user_id, url) DO NOTHING`,
    [USER, url]
  )

try {
  // A pre-existing permanent click, as a real user would have.
  await db.query(
    `INSERT INTO clicked_link (user_id, url, platform) VALUES ($1, $2, 'tiktok')
     ON CONFLICT (user_id, url) DO NOTHING`,
    [USER, A]
  )

  console.log('the setting is on, and the user opens a link:')
  check('  the session record starts empty', await session(), [])
  await note(A)
  check('  opening A records it for the session', await session(), [A])
  await note(A)
  check('  opening it twice records it once', await session(), [A])
  await note(B)
  check('  a second link joins it', await session(), [A, B])

  console.log('\nthe permanent record is untouched by any of that:')
  check('  it still holds only the original click', await permanent(), [A])

  console.log('\nwhat the feed hides, in each state:')
  // With the setting OFF the permanent record is what hides links; with it ON
  // the session record takes its place. A is in both, B only in the session.
  const off = new Set(await permanent())
  const on = new Set(await session())
  check('  off: A hidden (opened at some point)', off.has(A), true)
  check('  off: B served (never permanently clicked)', off.has(B), false)
  check('  on:  A hidden (opened this session)', on.has(A), true)
  check('  on:  B hidden too', on.has(B), true)

  console.log('\nswitching the setting clears the session:')
  await db.query('DELETE FROM clean_session_click')
  check('  the session record is empty', await session(), [])
  check('  the permanent record survived', await permanent(), [A])
} finally {
  await db.query('DELETE FROM clean_session_click WHERE user_id = $1', [USER])
  await db.query('DELETE FROM clicked_link WHERE user_id = $1', [USER])
  await db.end()
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
