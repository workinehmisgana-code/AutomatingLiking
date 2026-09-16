// The company-email task: submitted → unapproved → approved → payable.
//
// This one moves money, so the rules that matter are the ones about when an
// address is WORTH something:
//
//   * a submitted address is shown to the worker and is NOT payable;
//   * it becomes payable only when an admin approves it;
//   * approveUserPay snapshots `total`, so an unchecked address must stay out
//     of `total` or a payout run would approve work nobody looked at;
//   * an address can be submitted once, by one person — otherwise two workers
//     claim the same mailbox and both are paid;
//   * a decided submission cannot be re-decided, in either direction.
//
// Runs against the real database on a throwaway user, then removes everything
// it created.
//
//   node scripts/check-account-task.mjs
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

// ── the address rule, which the page and the route both apply ──────────────
// Same predicate as lib/config.ts isCompanyEmail.
const isCompanyEmail = (email, domain) => {
  const e = String(email ?? '').trim().toLowerCase()
  const d = String(domain ?? '').trim().toLowerCase().replace(/^@/, '')
  if (!d) return false
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return false
  return e.endsWith(`@${d}`)
}
console.log('only addresses on our own domain count:')
check('  ours', isCompanyEmail('sara@example.com', 'example.com'), true)
check('  gmail', isCompanyEmail('sara@gmail.com', 'example.com'), false)
check('  a lookalike domain', isCompanyEmail('sara@notexample.com', 'example.com'), false)
check('  a subdomain of ours is still not ours', isCompanyEmail('a@mail.example.com', 'example.com'), false)
check('  nonsense', isCompanyEmail('sara', 'example.com'), false)
check('  nothing configured accepts nothing', isCompanyEmail('sara@example.com', ''), false)
check('  the rule lives in config', /export function isCompanyEmail/.test(read('lib/config.ts')), true)

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

// The app creates this on first use; do the same so this can run standalone.
await db.query(`
  CREATE TABLE IF NOT EXISTS account_submission (
    id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', reject_reason TEXT,
    paid BOOLEAN NOT NULL DEFAULT false,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ, reviewed_by TEXT);
  CREATE UNIQUE INDEX IF NOT EXISTS account_submission_email_key
    ON account_submission (lower(email));`)

const RATE = 50
const A = '__acct_check_user_a__'
const B = '__acct_check_user_b__'
const MAIL = '__acctcheck__@example.com'

const owed = async (uid) =>
  (
    await q(
      `SELECT COUNT(*) FILTER (WHERE status = 'approved' AND paid = false)::int AS ok,
              COUNT(*) FILTER (WHERE status = 'pending')::int                  AS waiting
         FROM account_submission WHERE user_id = $1`,
      [uid]
    )
  )[0]

const submit = (uid, email) =>
  db.query(
    `INSERT INTO account_submission (user_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING
     RETURNING id`,
    [uid, email]
  )

const review = (id, approve, reason) =>
  db.query(
    `UPDATE account_submission
        SET status = $2, reject_reason = $3, reviewed_at = now(), reviewed_by = 'check'
      WHERE id = $1 AND status = 'pending'`,
    [id, approve ? 'approved' : 'rejected', reason]
  )

try {
  console.log('\na submitted address is shown but not payable:')
  const first = await submit(A, MAIL)
  const id = Number(first.rows[0]?.id)
  check('  it was recorded', Number.isFinite(id) && id > 0, true)
  let s = await owed(A)
  check('  awaiting a check', s.waiting, 1)
  check('  payable', s.ok, 0)
  check('  so the worker sees it as unapproved birr', s.waiting * RATE, RATE)
  check('  and is owed nothing yet', s.ok * RATE, 0)

  console.log('\nnobody else can claim the same mailbox:')
  const dup = await submit(B, MAIL.toUpperCase())
  check('  a second submission is refused', dup.rows.length, 0)
  check('  even in different case', (await owed(B)).waiting, 0)

  console.log('\napproving is what makes it money:')
  await review(id, true, null)
  s = await owed(A)
  check('  no longer awaiting', s.waiting, 0)
  check('  now payable', s.ok, 1)
  check('  worth its rate', s.ok * RATE, RATE)

  console.log('\nand a decision is final:')
  const again = await review(id, false, 'changed my mind')
  check('  it cannot be reversed here', again.rowCount, 0)
  check(
    '  the row is untouched',
    (await q('SELECT status, reject_reason FROM account_submission WHERE id = $1', [id]))[0],
    { status: 'approved', reject_reason: null }
  )

  console.log('\na rejection pays nothing and says why:')
  const r2 = await submit(A, `__acctcheck2__@example.com`)
  const id2 = Number(r2.rows[0].id)
  await review(id2, false, 'mailbox does not exist')
  s = await owed(A)
  check('  still one payable, not two', s.ok, 1)
  check('  nothing awaiting', s.waiting, 0)
  check(
    '  the reason is stored for the worker',
    (await q('SELECT reject_reason FROM account_submission WHERE id = $1', [id2]))[0].reject_reason,
    'mailbox does not exist'
  )
} finally {
  await db.query('DELETE FROM account_submission WHERE user_id = ANY($1::text[])', [[A, B]])
  await db.end()
}

// ── the wiring that keeps the two numbers apart ────────────────────────────
const dbSrc = read('lib/db.ts')
console.log('\nan unchecked address can never be paid out by accident:')
check(
  '  it is excluded from the payable total',
  /const total = comments\.birr \+ video\.birr \+ promo\.birr \+ accounts\.birr/.test(dbSrc),
  true
)
check(
  '  and shown under unapproved instead',
  /unapprovedBirr: unapprovedBirr \+ accountsAwaiting\.birr/.test(dbSrc),
  true
)
check(
  '  the admin-wide totals use the same rule',
  /p\.total = p\.comments\.birr \+ p\.video\.birr \+ p\.promo\.birr \+ p\.accounts\.birr/.test(dbSrc),
  true
)
check('  approveUserPay still snapshots total', /approved_amount\b/.test(dbSrc), true)
check(
  '  one address, one payment',
  /CREATE UNIQUE INDEX IF NOT EXISTS account_submission_email_key/.test(dbSrc),
  true
)
check(
  '  only a pending row may be reviewed',
  /WHERE id = \$1 AND status = 'pending'/.test(dbSrc),
  true
)

const adminRoute = read('app/api/admin/tasks/accounts/route.ts')
const userRoute = read('app/api/tasks/accounts/route.ts')
console.log('\nthe two routes guard what they should:')
check('  a rejection needs a reason', /Give a reason for the rejection/.test(adminRoute), true)
check('  the domain is checked on submit', /isCompanyEmail\(email, domain\)/.test(userRoute), true)
check('  a closed task refuses submissions', /This task is closed right now/.test(userRoute), true)
check(
  '  and a task with no domain counts as closed',
  /open: open && !!domain/.test(userRoute),
  true
)

const guide = read('components/GuideContent.ts')
console.log('\nthe guide describes it in both languages, only while it is open:')
check('  english', /Email task/.test(guide), true)
check('  amharic', /የኢሜይል ሥራ/.test(guide), true)
check('  both behind the same switch', (guide.match(/p\.accountOpen/g) ?? []).length >= 5, true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
