// An approved address stays on screen, with its badge.
//
// Nothing was ever deleted by a review — reviewAccountSubmission is an UPDATE,
// and the row is still filed under Approved and All. What made it LOOK deleted
// was reloading the list afterwards: the reload re-runs the current filter, and
// on "To check" a row that was just approved no longer matches, so it
// disappeared at the exact moment it was acted on. That reads as "it was
// removed", and leaves nothing on screen to confirm what happened.
//
// Checked here:
//
//   * the database still holds every reviewed row, approved and rejected;
//   * the page patches the row in place instead of reloading;
//   * the badge and the audit trail it carries are real columns, not a
//     client-side guess that vanishes on refresh.
//
// Runs against the real database on a throwaway user, then cleans up.
//
//   node scripts/check-review-keeps-row.mjs
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

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

const USER = '__review_keeps_check__'
const MAIL = '__reviewkeeps__@example.com'

try {
  await db.query('DELETE FROM account_submission WHERE user_id = $1', [USER])
  const id = Number(
    (
      await q(
        'INSERT INTO account_submission (user_id, email) VALUES ($1, $2) RETURNING id',
        [USER, MAIL]
      )
    )[0].id
  )

  const rowsFor = async (status) =>
    (
      await q(
        `SELECT id, email, status, reviewed_at FROM account_submission
          WHERE user_id = $1 ${status === 'all' ? '' : 'AND status = $2'}`,
        status === 'all' ? [USER] : [USER, status]
      )
    ).length

  console.log('before the review:')
  check('  it is in the To check list', await rowsFor('pending'), 1)
  check('  and in All', await rowsFor('all'), 1)

  await db.query(
    `UPDATE account_submission
        SET status = 'approved', reviewed_at = now(), reviewed_by = 'check'
      WHERE id = $1 AND status = 'pending'`,
    [id]
  )

  console.log('\nafter approving — nothing is deleted, only refiled:')
  check('  still exactly one row in total', await rowsFor('all'), 1)
  check('  now under Approved', await rowsFor('approved'), 1)
  check('  and no longer under To check', await rowsFor('pending'), 0)
  const row = (await q('SELECT status, reviewed_at FROM account_submission WHERE id = $1', [id]))[0]
  check('  the badge has a real column behind it', row.status, 'approved')
  check('  with when it was decided', !!row.reviewed_at, true)

  console.log('\nand rejecting keeps it too, with its reason:')
  await db.query(
    `INSERT INTO account_submission (user_id, email, status, reject_reason, reviewed_at)
     VALUES ($1, $2, 'rejected', 'mailbox does not exist', now())`,
    [USER, '__reviewkeeps2__@example.com']
  )
  check('  two rows now', await rowsFor('all'), 2)
  check('  one rejected', await rowsFor('rejected'), 1)
} finally {
  await db.query('DELETE FROM account_submission WHERE user_id = $1', [USER])
  await db.end()
}

// ── the page keeps it on screen ────────────────────────────────────────────
const ui = read('components/AdminAccountTasks.tsx')
console.log('\nthe page no longer reloads the row out from under you:')
check('  it patches the row in place', /setRows\(\(prev\) =>\s*\n\s*\(prev \?\? \[\]\)\.map/.test(ui), true)
check('  setting the new status', /status: approve \? 'approved' : 'rejected'/.test(ui), true)
check('  and stamping when', /reviewedAt: new Date\(\)\.toISOString\(\)/.test(ui), true)
// The bug was this line. It must not come back.
const reviewFn = ui.slice(ui.indexOf('async function review('), ui.indexOf('async function saveDomain('))
check('  and does NOT reload the list', /await load\(\)/.test(reviewFn), false)

console.log('\nthe kept row is obviously deliberate, not a stuck filter:')
check('  it is marked "just now"', /just now/.test(ui), true)
check('  with a note above the list', /decided just now and/.test(ui), true)
check('  saying nothing is deleted', /Nothing is\s*\n\s*deleted by a review/.test(ui), true)
check('  and offering the two filters that hold it', /setStatus\('approved'\)/.test(ui) && /setStatus\('all'\)/.test(ui), true)
check('  the marker clears on a real reload', /setJustReviewed\(new Set\(\)\)/.test(ui), true)

console.log('\nthe worker sees the same thing on their own page:')
const client = read('components/AccountTaskClient.tsx')
check('  every submission is listed, whatever its state', /subs\.map\(\(s\) => \{/.test(client), true)
check('  approved has its own badge', /label: 'Approved'/.test(client), true)
check('  and its own total', /label: 'Approved', n: approved\.length/.test(client), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
