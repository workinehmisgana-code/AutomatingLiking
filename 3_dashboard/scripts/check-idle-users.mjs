// Are workers who stopped a fortnight ago out of the way — and only them?
//
// The admin list had grown to 161 people of whom 100 had done nothing for two
// weeks or had never started, which is a list nobody can read. The answer is a
// filter rather than a destructor: deleting an account throws away its
// submissions, its screenshots and the record of what it was owed, and it cannot
// be undone if the rule catches somebody who was on holiday.
//
// THREE RULES DECIDE WHO DISAPPEARS, and each one is here because getting it
// wrong hurts a person rather than a number:
//
//   any work counts     a click, a comment report, a video, a repost, a mailbox.
//                       Somebody uploading videos all week is not idle because
//                       they did not click anything.
//   not since the reset the reset is about output; this is about whether they are
//                       still here, and a reset last Tuesday does not turn a
//                       fortnight of silence into three days of it.
//   never owed money    anyone with unpaid work stays visible whatever the dates
//                       say. Hiding somebody you have not paid is how they stop
//                       being paid.
//
//   node scripts/check-idle-users.mjs
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
const ui = read('components/AdminDashboard.tsx')
const db = read('lib/db.ts')

console.log('idle is measured across every kind of work:')
check('  from one query', /export function getLastWorkByUser/.test(db), true)
for (const t of ['clicked_link', 'commented_submission', 'video_submission', 'promo_link', 'account_submission']) {
  check(`  ${t}`, new RegExp(`FROM ${t}`).test(db.slice(db.indexOf('getLastWorkByUserUncached'), db.indexOf('getLastWorkByUserUncached') + 1400)), true)
}
check('  and not scoped to the reset', /NOT SCOPED TO THE RESET/.test(db), true)
check('  carried on the row', /lastWorkAt: string \| null/.test(db), true)
check('  cached, like the click counts', /cached\('lastWorkByUser'/.test(db), true)

console.log('\nnothing is deleted:')
check('  the list is filtered, not the table', /const shownUsers = showIdle/.test(ui), true)
check('  deleteUser is not called by it', /deleteUser/.test(ui), false)
check('  and the reason is written down', /a filter, not\n   \* a destructor/.test(ui), true)

console.log('\nwho is spared:')
check('  anyone owed money', /if \(owed\) return false/.test(ui), true)
check('  counting every kind of pay', /accountsAwaiting\.count \?\? 0/.test(ui), true)
check('  and the reason', /how they stop being paid/.test(ui), true)
// A brand-new sign-up gets the same fortnight before it counts as abandoned.
check('  a new account gets the same two weeks', /Date\.parse\(u\.createdAt\)/.test(ui), true)
check('  at fourteen days', /const IDLE_DAYS = 14/.test(ui), true)

console.log('\nand they can be brought back:')
check('  one click', /setShowIdle\(\(v\) => !v\)/.test(ui), true)
check('  the count is on the button', /idle hidden · show/.test(ui), true)
check('  the header says how many of how many', /of \$\{data\.users\.length\}/.test(ui), true)

// ── who this hides today ───────────────────────────────────────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const LAST = `
  WITH last AS (
    SELECT u.id, COALESCE(p.name, u.name, u.email) AS who, p.created_at AS joined,
      GREATEST(
        COALESCE((SELECT max(clicked_at)   FROM clicked_link c         WHERE c.user_id = u.id), '-infinity'),
        COALESCE((SELECT max(submitted_at) FROM commented_submission s WHERE s.user_id = u.id), '-infinity'),
        COALESCE((SELECT max(uploaded_at)  FROM video_submission v     WHERE v.user_id = u.id), '-infinity'),
        COALESCE((SELECT max(submitted_at) FROM promo_link r           WHERE r.user_id = u.id), '-infinity'),
        COALESCE((SELECT max(submitted_at) FROM account_submission a   WHERE a.user_id = u.id), '-infinity')
      ) AS last_work
      FROM "user" u LEFT JOIN user_profile p ON p.user_id = u.id
  )`
const { rows } = await pool
  .query(
    LAST + `
    SELECT count(*)::int total,
           count(*) FILTER (WHERE last_work > now() - interval '14 days')::int active,
           count(*) FILTER (WHERE last_work = '-infinity')::int never_worked,
           count(*) FILTER (WHERE last_work <> '-infinity'
                              AND last_work < now() - interval '14 days')::int stopped
      FROM last`
  )
  .catch(() => ({ rows: [] }))
const r = rows[0]
if (r) {
  console.log('\non the live data:')
  console.log(`   ${r.total} users — ${r.active} active, ${r.stopped} stopped, ${r.never_worked} never started`)
  console.log(`   so the list shows ${r.active} by default, plus anyone still owed money`)
}
await pool.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
