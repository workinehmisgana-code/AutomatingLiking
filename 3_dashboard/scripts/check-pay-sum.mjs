// Does a user's pay add up on screen, including the work other people did?
//
// A user earns from five things, and one of them — the referral share — is 20% of
// the comment pay of the people they referred. It has always been inside `total`,
// but the card showed five figures in a row and the total in the corner, which
// asks whoever is approving a payment to add up somebody's wages in their head
// and gives them no way to see that the referral share is already in there. It is
// the line people query, precisely because it is earned on somebody else's work.
//
// So the card now lists each kind of work with what it is made of, then the sum
// written out, then the total.
//
//   node scripts/check-pay-sum.mjs
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
const cfg = read('lib/config.ts')

console.log('other people’s work is in the total:')
check('  the total adds the referral share',
      /const total = comments\.birr \+ video\.birr \+ promo\.birr \+ referrals\.birr/.test(db),
      true)
check('  at a fixed share of their comment pay', /export const REFERRAL_PAY_RATE = COMMENT_PAY_RATE \* REFERRAL_SHARE/.test(cfg), true)
check('  paid on top, not deducted', /nothing is deducted from the worker/.test(db), true)
// The one thing that must never be added: their count and this user's count are
// different people's comments.
check('  and the counts are kept apart', /must\n   \* never be added together/.test(db), true)
// Awaiting mailboxes are deliberately outside the total.
// Mailbox money of either kind is outside this total now — it is settled on the
// Email tasks page, which is where it is checked.
check('  mailbox money stays out', /MAILBOX MONEY IS NOT IN THE TOTAL/.test(db), true)

console.log('\nand the card shows the working, not just the answer:')
check('  one line per kind of work', /const parts = \[/.test(ui), true)
check('  with what each is made of', /\$\{pending\.comments\.count\} × \$\{COMMENT_PAY_RATE\}/.test(ui), true)
check('  the referral line at the referral rate', /\$\{pending\.referrals\.count\} × \$\{REFERRAL_PAY_RATE\}/.test(ui), true)
check('  named as somebody else’s work', /other people\\u2019s work, paid on top/.test(ui), true)
check('  and coloured apart from their own', /text-sky-300/.test(ui), true)
check('  empty lines are left out', /\.filter\(\(x\) => x\.birr > 0\)/.test(ui), true)
check('  the addition is written out', /\.map\(\(x\) => fmtBirr\(x\.birr\)\)\.join\(' \+ '\)/.test(ui), true)
check('  only when there is more than one part', /parts\.length > 1/.test(ui), true)
check('  and the sum is the total', /const sum = parts\.reduce\(\(n, x\) => n \+ x\.birr, 0\)/.test(ui), true)
check('  labelled as such', /total for this user/.test(ui), true)
check('  email pay is shown outside it', /Email task, paid separately/.test(ui), true)
check('  and says where to settle it', /settle it on the Email tasks page/.test(ui), true)

// ── the arithmetic, against the live rows ──────────────────────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const rate = Number((cfg.match(/export const COMMENT_PAY_RATE = (\d+(?:\.\d+)?)/) || [])[1] || 0)
const share = Number((cfg.match(/export const REFERRAL_SHARE = ([\d.]+)/) || [])[1] || 0)
const { rows } = await pool
  .query(
    // The same population the card counts: comment submissions since the later of
    // the global start, this user's reset and their last comment payout — and the
    // referral table, which is the one source for who earns a share of whom.
    `SELECT p.user_id, p.name,
            COALESCE((SELECT sum(cs.count)::int FROM commented_submission cs
               LEFT JOIN user_reset ur ON ur.user_id = cs.user_id
               LEFT JOIN comment_pay_marker cpm ON cpm.user_id = cs.user_id
              WHERE cs.user_id = p.user_id
                AND cs.submitted_at >= GREATEST(
                      COALESCE(ur.reset_at, '-infinity'::timestamptz),
                      COALESCE(cpm.paid_at, '-infinity'::timestamptz))), 0) AS own,
            COALESCE((SELECT sum(cs.count)::int FROM referral r
               JOIN commented_submission cs ON cs.user_id = r.user_id
               LEFT JOIN user_reset ur ON ur.user_id = cs.user_id
               LEFT JOIN comment_pay_marker cpm ON cpm.user_id = cs.user_id
              WHERE r.referrer_id = p.user_id
                AND cs.submitted_at >= GREATEST(
                      COALESCE(ur.reset_at, '-infinity'::timestamptz),
                      COALESCE(cpm.paid_at, '-infinity'::timestamptz))), 0) AS referred,
            (SELECT count(*)::int FROM referral r WHERE r.referrer_id = p.user_id) AS people
       FROM user_profile p
      WHERE EXISTS (SELECT 1 FROM referral r WHERE r.referrer_id = p.user_id)
      ORDER BY 4 DESC
      LIMIT 8`
  )
  .catch((e) => ({ rows: [{ err: String(e).slice(0, 90) }] }))
console.log('\nwhat the sum looks like for the users with referred workers:')
for (const r of rows) {
  if (r.err) {
    console.log('   (could not read:', r.err, ')')
    break
  }
  const ownBirr = (r.own ?? 0) * rate
  const refBirr = Math.round((r.referred ?? 0) * rate * share)
  console.log(
    `   ${(r.name ?? '(no name)').slice(0, 18).padEnd(19)} own ${String(r.own).padStart(5)} ` +
      `comments = ${String(ownBirr).padStart(6)}  +  ${String(r.referred).padStart(5)} ` +
      `others’ = ${String(refBirr).padStart(5)}  =  ${ownBirr + refBirr} birr of comment pay`
  )
}
console.log(
  '   (unpaid comment pay only — video and repost pay join this sum; mailboxes are\n' +
    '    settled on the Email tasks page and are not in it)'
)
await pool.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
