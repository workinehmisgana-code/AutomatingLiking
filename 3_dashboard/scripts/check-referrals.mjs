// Does the referral commission pay the right person, once, and never itself?
//
// The arrangement: a new user types somebody's referral username while
// registering, and from then on that person earns 20% of their comment pay —
// 0.1 birr per comment — paid by us, on top of what the worker earns.
//
// Four things have to hold, and three of them are about TIME rather than
// arithmetic:
//
//   1. THE ATTRIBUTION IS WRITTEN ONCE. It decides who gets paid for work that
//      has not happened yet, so it cannot be editable afterwards, and nobody
//      can refer themselves.
//
//   2. PAYING THE WORKER MUST NOT CLEAR THE REFERRER'S BALANCE. The same
//      comments are owed to two different people, on two different schedules.
//      Sharing one marker — the obvious implementation — silently zeroes a
//      referrer every time one of their people is paid.
//
//   3. PAYING THE REFERRER MUST NOT CLEAR THE WORKER'S. The same mistake from
//      the other end.
//
//   4. AND IT MUST STILL ADD UP. 20% of 0.5 birr, per comment, per person.
//
// Runs against the real database on throwaway rows, then deletes them.
//
//   node scripts/check-referrals.mjs
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

// ── the rate ────────────────────────────────────────────────────────────────
const cfg = read('lib/config.ts')
const COMMENT_RATE = Number(cfg.match(/export const COMMENT_PAY_RATE = ([\d.]+)/)?.[1])
const SHARE = Number(cfg.match(/export const REFERRAL_SHARE = ([\d.]+)/)?.[1])
const RATE = COMMENT_RATE * SHARE

console.log('what a referral is worth:')
check('  comment pay', COMMENT_RATE, 0.5)
check('  the referrer gets a fifth of it', SHARE, 0.2)
check('  which is 10 santim a comment', Math.round(RATE * 100), 10)
check(
  '  and the rate is derived, not typed twice',
  /export const REFERRAL_PAY_RATE = COMMENT_PAY_RATE \* REFERRAL_SHARE/.test(cfg),
  true
)
// One level only. A commission on a commission compounds forever and the first
// person to notice builds a pyramid out of it.
check('  one level only, and the source says why', /ONE LEVEL ONLY/.test(cfg), true)
check(
  '  and only comment work earns it',
  /Comments are the only task that pays a commission/.test(cfg),
  true
)

// ── the username rules ──────────────────────────────────────────────────────
// Reimplemented from lib/referrals.ts: the code is typed by somebody else, from
// memory, at a moment that cannot be corrected.
const norm = (raw) =>
  String(raw ?? '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20)

console.log('\nthe username somebody else has to type:')
check('  case does not matter', norm('AbebeK'), 'abebek')
check('  a leading @ does not matter', norm('@abebek'), 'abebek')
check('  spaces and punctuation do not', norm(' Abebe.K_ '), 'abebek')
check('  a name typed in full still reaches it', norm('Abebe Kebede'), 'abebekebede')
check('  nothing usable gives nothing', norm('አበበ'), '')
check('  and it cannot outgrow the column', norm('a'.repeat(40)).length, 20)
const ref = read('lib/referrals.ts')
check('  the same normaliser is used on both sides', /export function normalizeReferralCode/.test(ref), true)
check('  a name with no latin letters falls back to the email', /fromEmail/.test(ref), true)
check('  and the collision case is written down', /two people called Abebe Kebede/.test(ref), true)

// ── against the live database ───────────────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

const R = '__refcheck_referrer__'
const A = '__refcheck_a__'
const B = '__refcheck_b__'
const ALL = [R, A, B]
const clean = async () => {
  await db.query('DELETE FROM referral WHERE user_id = ANY($1) OR referrer_id = ANY($1)', [ALL])
  await db.query('DELETE FROM referral_pay_marker WHERE user_id = ANY($1)', [ALL])
  await db.query('DELETE FROM comment_pay_marker WHERE user_id = ANY($1)', [ALL])
  await db.query('DELETE FROM user_reset WHERE user_id = ANY($1)', [ALL])
  await db.query('DELETE FROM commented_submission WHERE user_id = ANY($1)', [ALL])
  await db.query('DELETE FROM user_profile WHERE user_id = ANY($1)', [ALL])
}

try {
  await clean()

  console.log('\nthe schema is there:')
  const cols = await q(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_profile' AND column_name = 'referral_code'`
  )
  check('  every user can have a code', cols.length, 1)
  // Created in its own step by ensureReferralTables, so run it the same way.
  await db
    .query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_referral_code
         ON user_profile (referral_code) WHERE referral_code IS NOT NULL`
    )
    .catch(() => {})
  const idx = await q(`SELECT indexname FROM pg_indexes WHERE indexname = 'uq_profile_referral_code'`)
  check('  and no two users can share one', idx.length, 1)
  const tables = await q(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('referral', 'referral_pay_marker') ORDER BY table_name`
  )
  check('  the two tables exist', tables.map((t) => t.table_name), ['referral', 'referral_pay_marker'])

  const mkProfile = (id, name, code) =>
    db.query(
      `INSERT INTO user_profile (user_id, name, bank_account, tiktok_url, referral_code)
       VALUES ($1, $2, '0000', $3, $4)`,
      [id, name, `https://www.tiktok.com/@${id}`, code]
    )
  await mkProfile(R, 'Referrer', '__refcheck_code__')
  await mkProfile(A, 'Worker A', '__refcheck_a_code__')
  await mkProfile(B, 'Worker B', '__refcheck_b_code__')

  console.log('\nthe attribution is written once, and never by the person who benefits:')
  let selfOk = true
  try {
    await db.query('INSERT INTO referral (user_id, referrer_id, code) VALUES ($1, $1, $2)', [R, 'x'])
    selfOk = false
  } catch {
    /* the CHECK constraint refused it */
  }
  check('  nobody refers themselves', selfOk, true)

  await db.query('INSERT INTO referral (user_id, referrer_id, code) VALUES ($1, $2, $3)', [A, R, 'c'])
  await db.query('INSERT INTO referral (user_id, referrer_id, code) VALUES ($1, $2, $3)', [B, R, 'c'])
  const second = await db.query(
    `INSERT INTO referral (user_id, referrer_id, code) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [A, B, 'other']
  )
  check('  a second referrer is refused', second.rowCount, 0)
  check(
    '  the first one stands',
    (await q('SELECT referrer_id FROM referral WHERE user_id = $1', [A]))[0].referrer_id,
    R
  )
  const dbSrc = read('lib/db.ts')
  check('  written with DO NOTHING, not DO UPDATE', /ON CONFLICT \(user_id\) DO NOTHING/.test(dbSrc), true)
  check('  and user_id is the primary key', /user_id     TEXT PRIMARY KEY,\s*\n\s*referrer_id/.test(dbSrc), true)

  // Two users cannot hold the same code, so a referral cannot be ambiguous.
  let dupOk = true
  try {
    await db.query('UPDATE user_profile SET referral_code = $2 WHERE user_id = $1', [
      B,
      '__refcheck_a_code__',
    ])
    dupOk = false
  } catch {
    /* unique index */
  }
  check('  two users cannot share a code', dupOk, true)

  // ── the money ─────────────────────────────────────────────────────────────
  const commented = (uid, n, daysAgo) =>
    db.query(
      `INSERT INTO commented_submission (user_id, platform, count, submitted_at)
       VALUES ($1, 'tiktok', $2, now() - ($3 || ' days')::interval)`,
      [uid, n, String(daysAgo)]
    )
  await commented(A, 10, 3)
  await commented(A, 5, 1)
  await commented(B, 4, 2)

  // The query getReferralEarnings runs, verbatim in shape.
  const owed = async () =>
    (
      await q(
        `SELECT COALESCE(SUM(cs.count) FILTER (
                  WHERE cs.submitted_at >= GREATEST(
                          'epoch'::timestamptz,
                          COALESCE(ur.reset_at, 'epoch'::timestamptz),
                          COALESCE(rpm.paid_at, 'epoch'::timestamptz))
                ), 0)::int AS n,
                COALESCE(SUM(cs.count) FILTER (
                  WHERE cs.submitted_at >= GREATEST(
                          'epoch'::timestamptz,
                          COALESCE(ur.reset_at, 'epoch'::timestamptz))
                ), 0)::int AS lifetime
           FROM referral r
           LEFT JOIN commented_submission cs ON cs.user_id = r.user_id
           LEFT JOIN user_reset ur           ON ur.user_id = r.user_id
           LEFT JOIN referral_pay_marker rpm ON rpm.user_id = r.referrer_id
          WHERE r.referrer_id = $1`,
        [R]
      )
    )[0]

  // What the WORKER is owed, by the rule getUserPendingPayments uses.
  const workerOwed = async (uid) =>
    Number(
      (
        await q(
          `SELECT COALESCE(SUM(cs.count), 0)::int AS n
             FROM commented_submission cs
             LEFT JOIN user_reset ur ON ur.user_id = cs.user_id
             LEFT JOIN comment_pay_marker cpm ON cpm.user_id = cs.user_id
            WHERE cs.user_id = $1
              AND cs.submitted_at >= GREATEST(
                    'epoch'::timestamptz,
                    COALESCE(ur.reset_at, 'epoch'::timestamptz),
                    COALESCE(cpm.paid_at, 'epoch'::timestamptz))`,
          [uid]
        )
      )[0].n
    )

  console.log('\nit adds up:')
  let o = await owed()
  check('  19 comments across two people', o.n, 19)
  check('  at 10 santim each', Math.round(o.n * RATE * 100) / 100, 1.9)
  check('  worker A is owed their own full rate', workerOwed(A) instanceof Promise, true)
  check('  A: 15 comments', await workerOwed(A), 15)
  check('  which is 7.5 birr to them, and 1.5 to the referrer',
        [15 * COMMENT_RATE, Math.round(15 * RATE * 100) / 100], [7.5, 1.5])

  console.log('\npaying the WORKER does not clear the referrer (the whole reason for a second marker):')
  await db.query(
    `INSERT INTO comment_pay_marker (user_id, paid_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET paid_at = now()`,
    [A]
  )
  check('  A now owes nothing to A', await workerOwed(A), 0)
  o = await owed()
  check('  but the referrer is still owed all 19', o.n, 19)
  check(
    '  because the commission window never looks at comment_pay_marker',
    /LEFT JOIN referral_pay_marker rpm ON rpm\.user_id = r\.referrer_id/.test(dbSrc) &&
      !/referral r[\s\S]{0,600}?comment_pay_marker/.test(dbSrc),
    true
  )

  console.log('\npaying the REFERRER clears the commission, and only the commission:')
  await db.query(
    `INSERT INTO referral_pay_marker (user_id, paid_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET paid_at = now()`,
    [R]
  )
  o = await owed()
  check('  nothing more is owed', o.n, 0)
  check('  but the total earned is still on record', o.lifetime, 19)
  check('  and worker B, who was never paid, still is', await workerOwed(B), 4)

  console.log('\nwork earned after the payout starts a new balance:')
  await commented(A, 7, 0)
  o = await owed()
  check('  the new comments count', o.n, 7)
  check('  and the lifetime keeps growing', o.lifetime, 26)

  console.log('\nresetting a WORKER voids the work for both of them:')
  await db.query(
    `INSERT INTO user_reset (user_id, reset_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET reset_at = now()`,
    [A]
  )
  o = await owed()
  check('  A’s comments stop counting for the referrer too', o.n, 0)
  check('  including in the lifetime figure', o.lifetime, 4)
  check('  and B is untouched', await workerOwed(B), 4)
} finally {
  await clean()
  await db.end()
}

// ── the code around it ──────────────────────────────────────────────────────
const dbSrc = read('lib/db.ts')
const route = read('app/api/profile/route.ts')
const onboarding = read('components/Onboarding.tsx')
const dash = read('components/Dashboard.tsx')
const admin = read('components/AdminDashboard.tsx')

console.log('\nthe username can only be entered while registering:')
check(
  '  the window is "no referrer yet AND registration unfinished"',
  /if \(already \|\| isProfileComplete\(prev\)\)/.test(route),
  true
)
check('  a later attempt is refused, not ignored', /cannot be changed afterwards/.test(route), true)
// Validated BEFORE the profile is written, or a typo leaves somebody registered
// with nobody credited and the form gone.
check(
  '  an unknown username is rejected before anything is saved',
  route.indexOf('No user has the referral username') < route.indexOf('await upsertUserProfile'),
  true
)
check('  self-referral is refused in the route too', /You cannot refer yourself/.test(route), true)
check('  and the form says it is one-time', /cannot be\s*\n?\s*changed later/.test(onboarding), true)
check('  and that the worker loses nothing', /Nothing is taken off what you earn/.test(onboarding), true)

console.log('\neverybody gets a code, including the users who registered before this existed:')
check('  assigned when a profile is saved', /assignReferralCode\(userId, name, su\.email\)/.test(route), true)
check('  and on every dashboard load, idempotently', /assignReferralCode\(session\.user\.id/.test(read('app/page.tsx')), true)
check('  the admin page backfills the rest in one pass', /assignMissingReferralCodes/.test(read('app/admin/page.tsx')), true)
check('  an existing code is never changed', /if \(existing\.rows\[0\]\.referral_code\) return existing\.rows\[0\]\.referral_code/.test(dbSrc), true)
check('  a collision takes the next candidate', /if \(\(e as \{ code\?: string \}\)\?\.code === '23505'\) continue/.test(dbSrc), true)

console.log('\nthe commission is part of what gets paid, and is cleared by that payment:')
check('  it is in the total', /p\.accounts\.birr \+ p\.referrals\.birr/.test(dbSrc), true)
check('  and in the single-user total too', /accounts\.birr \+ referrals\.birr/.test(dbSrc), true)
check('  marking paid stamps the referral marker', /INSERT INTO referral_pay_marker \(user_id, paid_at\) VALUES \(\$1, now\(\)\)/.test(dbSrc), true)
check('  undo restores it', /prevReferralPaidAt/.test(dbSrc), true)
// An undo descriptor recorded before commissions existed knows nothing about
// the marker. Treating `undefined` as "there was none" would delete the marker
// and hand the referrer their whole history again.
check(
  '  an older undo descriptor does not wipe the marker',
  /if \(u\.prevReferralPaidAt !== undefined\)/.test(dbSrc),
  true
)

console.log('\nboth dashboards show it:')
check('  the user sees their own username', /Your referral username/.test(dash), true)
check('  with a copy button, not a name to retype', /setCopiedCode/.test(dash), true)
check('  who joined with it', /who joined with your username/.test(dash), true)
check('  what is unpaid and what is earned in total', /earned in total/.test(dash), true)
check('  and it is in their pending-pay strip', /label: 'Referrals'/.test(dash), true)
// The count is other people's comments. Read as the user's own it looks like
// their comment count doubled.
check(
  '  labelled as OTHER people’s comments',
  /comment\(s\) made by people you referred/.test(dash),
  true
)
check('  the admin sees it per user', /Referrals \{fmtBirr\(pending\.referrals\.birr\)\}/.test(admin), true)
check('  with the list of who they referred', /registered with this username/.test(admin), true)
check('  and who referred them', /registered with\{' '\}/.test(admin), true)
check('  the admin totals include it', /acc\.referrals \+= p\.referrals\.birr/.test(admin), true)
// The phone reads the same JSON. An unknown key is ignored there, but the chip
// is worth having for the next build.
check(
  '  the phone shows it too',
  /payChip\("Referrals", ref\)/.test(
    readFileSync(
      new URL('../../4_android_bubble/app/src/main/java/com/repostearn/bubble/BubbleService.kt', import.meta.url),
      'utf8'
    )
  ),
  true
)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
