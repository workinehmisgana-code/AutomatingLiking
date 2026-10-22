// Is email work settled on the email page, and only there?
//
// It was not, in two ways that pulled against each other:
//
//   IT WAS IN THE MAIN TOTAL. `total` added validated mailboxes to comments,
//   video, repost and referral pay, so the user card asked an admin to approve a
//   balance that included work settled on another screen.
//
//   AND MARKING PAID NEVER CLEARED IT. markUserPaid updates video_submission,
//   promo_link and the two pay markers — it never touched account_submission. So
//   the mailbox money was counted in the amount handed over and then reappeared,
//   in full, in the next total. Every payout after the first one over-paid it.
//
// Both go away by taking email work out of that total and giving it its own
// buttons, which is what this checks.
//
//   node scripts/check-email-pay.mjs
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
const ui = read('components/AdminDashboard.tsx')
const page = read('components/AdminAccountTasks.tsx')
const route = read('app/api/admin/tasks/accounts/route.ts')

console.log('email money is out of the main total:')
check('  per user', /const total = comments\.birr \+ video\.birr \+ promo\.birr \+ referrals\.birr/.test(db), true)
check('  and in the bulk version the tiles use',
      /p\.total = p\.comments\.birr \+ p\.video\.birr \+ p\.promo\.birr \+ p\.referrals\.birr/.test(db), true)
check('  the reason is written down', /settled on the Email tasks page/.test(db), true)
check('  it is still reported', /accounts: PendingTask/.test(db), true)
// markUserPaid never cleared account_submission, so anything of theirs inside
// `total` was paid and then owed again.
check('  and mark-paid never cleared it', /account_submission SET paid = true WHERE user_id/.test(db), false)

console.log('\nthe card shows it beside the sum, not inside it:')
check('  not one of the summed parts', /key: 'accounts'/.test(ui), false)
check('  shown separately', /Email task, paid separately/.test(ui), true)
check('  with where to settle it', /settle it on the Email tasks page/.test(ui), true)
check('  and the tile says the same', /separate, on the Email tasks page/.test(ui), true)
check('  the headline hint no longer claims all tasks',
      /unapproved · comments, video, repost, referrals/.test(ui), true)

console.log('\nand the email page can pay it:')
check('  per worker', /async function payUser/.test(page), true)
check('  per address', /async function payOne/.test(page), true)
check('  undoable', /async function unpay/.test(page), true)
check('  the owed list is served with the rows', /getAccountPayByUser/.test(route), true)
check('  approved-and-unpaid only', /status = 'approved' AND paid = false/.test(db), true)
// The first version of the payer built one statement whose OR meant "every row"
// when an argument was absent.
check('  one branch each, not an OR', /ONE BRANCH EACH, spelled out/.test(db), true)
check('  and the confirmation says which pay it is', /EMAIL TASK only/.test(page), true)

// ── what this moves, on the live rows ──────────────────────────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const rate = Number((read('lib/config.ts').match(/ACCOUNT_PAY_BIRR = (\d+)/) || [])[1] || 0)
const { rows } = await pool
  .query(
    `SELECT COALESCE(u.name, a.user_id) AS who,
            count(*) FILTER (WHERE a.status='approved' AND NOT a.paid)::int owed,
            count(*) FILTER (WHERE a.status='approved' AND a.paid)::int paid,
            count(*) FILTER (WHERE a.status='pending')::int waiting
       FROM account_submission a LEFT JOIN "user" u ON u.id = a.user_id
      GROUP BY 1
     HAVING count(*) FILTER (WHERE a.status='approved' AND NOT a.paid) > 0
      ORDER BY 2 DESC LIMIT 12`
  )
  .catch(() => ({ rows: [] }))
let moved = 0
console.log('\nemail money that was sitting inside main balances:')
for (const r of rows) {
  moved += r.owed * rate
  console.log(
    `   ${String(r.who).slice(0, 22).padEnd(23)} ${String(r.owed).padStart(3)} × ${rate} = ` +
      `${String(r.owed * rate).padStart(6)} birr   (${r.paid} paid, ${r.waiting} awaiting a check)`
  )
}
console.log(`   ${moved} birr in total, now owed on the Email tasks page instead`)
await pool.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
