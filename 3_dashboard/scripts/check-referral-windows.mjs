// What closes a referrer's commission window — and what must not.
//
// A referrer is owed 20% of the comment pay of everybody they introduced, on
// top of what the worker earns. That debt is cleared by exactly one event: the
// REFERRER being marked paid, which stamps referral_pay_marker for them.
//
// IT USED TO BE CLEARED BY THE WORKER TOO. The commission window was also
// floored by the worker's own user_reset row, and the admin routine is to mark
// a worker paid and then reset them a minute later — so the reset moved the
// floor to now and every comment that worker had ever made stopped earning
// their referrer anything. Nobody was told; the number simply went to zero on a
// screen the referrer does not look at, and the money was never paid.
//
// This checks that the two windows are independent again, and prices what was
// lost before they were.
//
//   node scripts/check-referral-windows.mjs           report, and FAIL if a
//                                                     worker is still cutting
//                                                     somebody else's money
//   node scripts/check-referral-windows.mjs --detail  every pair, with its dates
import { readFileSync } from 'node:fs'

const DETAIL = process.argv.includes('--detail')

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

// Kept in step with lib/config.ts by hand; it is one multiplication.
const COMMENT_PAY_RATE = 0.25
const REFERRAL_SHARE = 0.2
const RATE = COMMENT_PAY_RATE * REFERRAL_SHARE

const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—')
const birr = (n) => `${(n).toLocaleString(undefined, { maximumFractionDigits: 2 })} birr`

try {
  const reset = (await db.query('SELECT reset_at FROM app_state WHERE id = 1')).rows[0].reset_at

  // Three counts per referral pair, from the same rows:
  //
  //   owed_now   the window as the code now computes it: the referrer's own
  //              payout, and nothing else
  //   owed_old   the window as it was, with the worker's reset in it too
  //   buried     comments the OLD window dropped because of the worker, before
  //              the referrer was ever paid for them — money that went missing
  //              rather than money that was settled
  const { rows } = await db.query(
    `SELECT r.referrer_id, r.user_id,
            rp.name AS referrer, p.name AS worker,
            rpm.paid_at  AS referrer_paid,
            urr.reset_at AS referrer_reset,
            cpm.paid_at  AS worker_paid,
            ur.reset_at  AS worker_reset,
            COALESCE(SUM(cs.count), 0)::int AS all_comments,
            COALESCE(SUM(cs.count) FILTER (
              WHERE cs.submitted_at >= GREATEST($1::timestamptz, COALESCE(rpm.paid_at, $1::timestamptz))
            ), 0)::int AS owed_now,
            COALESCE(SUM(cs.count) FILTER (
              WHERE cs.submitted_at >= GREATEST($1::timestamptz,
                                                COALESCE(ur.reset_at, $1::timestamptz),
                                                COALESCE(rpm.paid_at, $1::timestamptz))
            ), 0)::int AS owed_old,
            COALESCE(SUM(cs.count) FILTER (
              WHERE ur.reset_at IS NOT NULL
                AND cs.submitted_at >= $1::timestamptz
                AND cs.submitted_at <  ur.reset_at
                AND (rpm.paid_at IS NULL OR rpm.paid_at > ur.reset_at)
            ), 0)::int AS buried
       FROM referral r
       LEFT JOIN user_profile rp         ON rp.user_id  = r.referrer_id
       LEFT JOIN user_profile p          ON p.user_id   = r.user_id
       LEFT JOIN referral_pay_marker rpm ON rpm.user_id = r.referrer_id
       LEFT JOIN user_reset urr          ON urr.user_id = r.referrer_id
       LEFT JOIN comment_pay_marker cpm  ON cpm.user_id = r.user_id
       LEFT JOIN user_reset ur           ON ur.user_id  = r.user_id
       LEFT JOIN commented_submission cs ON cs.user_id  = r.user_id
      GROUP BY r.referrer_id, r.user_id, rp.name, p.name, rpm.paid_at, urr.reset_at,
               cpm.paid_at, ur.reset_at
      ORDER BY rp.name, p.name`,
    [reset]
  )

  console.log(`Global reset: ${iso(reset)} · ${rows.length} referral pair(s) · ${RATE} birr a comment\n`)

  const cutByWorker = rows.filter((r) => r.owed_now > r.owed_old)
  const buriedRows = rows.filter((r) => r.buried > 0)

  if (DETAIL) {
    for (const r of rows) {
      console.log(`${String(r.referrer ?? '?').slice(0, 20).padEnd(20)} <- ${String(r.worker ?? '?').slice(0, 20)}`)
      console.log(`   ${String(r.all_comments).padStart(6)} comments ever · owed now ${String(r.owed_now).padStart(6)} · under the old rule ${String(r.owed_old).padStart(6)}`)
      console.log(`   referrer: paid ${iso(r.referrer_paid)}, reset ${iso(r.referrer_reset)}`)
      console.log(`   worker:   paid ${iso(r.worker_paid)}, reset ${iso(r.worker_reset)}`)
      console.log()
    }
  }

  // ── what the fix gives back ───────────────────────────────────────────────
  console.log('Restored by the fix (was being hidden by a worker, not yet paid out):')
  if (!cutByWorker.length) {
    console.log('  nothing — no unpaid commission is currently cut by a worker.')
  } else {
    let total = 0
    for (const r of cutByWorker) {
      const n = r.owed_now - r.owed_old
      total += n * RATE
      console.log(`  ${String(r.referrer).padEnd(20)} +${String(n).padStart(6)} comments  ${birr(n * RATE).padStart(14)}  (via ${r.worker})`)
    }
    console.log(`  ${''.padEnd(20)} ${''.padStart(7)}            ${birr(total).padStart(14)} in total`)
  }

  // ── what cannot be given back ─────────────────────────────────────────────
  //
  // A referrer who was marked paid AFTER the worker was reset was paid an
  // amount that had already had the commission taken out of it. Their marker is
  // now past those comments, so no change to the window can bring them back: it
  // is a debt, and the only way out of it is a payment.
  console.log('\nLost before the fix (the referrer was paid an amount that excluded it):')
  const settled = rows.filter(
    (r) =>
      r.worker_reset &&
      r.referrer_paid &&
      new Date(r.referrer_paid) > new Date(r.worker_reset) &&
      r.all_comments > 0
  )
  if (!settled.length) {
    console.log('  nothing.')
  } else {
    let total = 0
    for (const r of settled) {
      // HOW FAR BACK THE DEBT GOES. Only as far as the referrer's PREVIOUS
      // payout: anything before that was settled then, under a window that had
      // not yet been spoiled by this worker's reset. Measuring from the global
      // reset instead would bill the same commission twice over.
      //
      // referral_pay_marker keeps one timestamp and overwrites it, so the
      // previous payout is not in it. user_snapshot is — the admin screen
      // writes one immediately before every mark-paid — so the latest snapshot
      // taken BEFORE the current marker is when the referrer was last settled.
      //
      // NOT just "the latest snapshot before the marker": the snapshot for THIS
      // payout is written a fraction of a second before it, so that is the one
      // that comes back, the window collapses to nothing and the whole debt
      // prices at zero. What is wanted is the snapshot before THAT one.
      //
      // An estimate, and worth saying so: a snapshot is only written when the
      // admin screen sends one, so a payout made another way leaves no mark and
      // this reaches further back than it should.
      const { rows: prev } = await db.query(
        `SELECT max(created_at) AS prev_payout
           FROM user_snapshot
          WHERE user_id = $1
            AND created_at < (
              SELECT max(created_at) FROM user_snapshot
               WHERE user_id = $1 AND created_at <= $2::timestamptz
            )`,
        [r.referrer_id, r.referrer_paid]
      )
      const since = prev[0]?.prev_payout ?? reset
      const { rows: pre } = await db.query(
        `SELECT COALESCE(SUM(cs.count), 0)::int AS n
           FROM commented_submission cs
          WHERE cs.user_id = $1
            AND cs.submitted_at >= GREATEST($2::timestamptz, $3::timestamptz)
            AND cs.submitted_at <  $4::timestamptz`,
        [r.user_id, reset, since, r.worker_reset]
      )
      const n = pre[0].n
      if (!n) continue
      total += n * RATE
      console.log(`  ${String(r.referrer).padEnd(20)} ${String(n).padStart(6)} comments  ${birr(n * RATE).padStart(14)}  (via ${r.worker})`)
      console.log(`  ${''.padEnd(20)} earned between ${iso(since)} (their previous payout) and ${iso(r.worker_reset)} (that worker's reset)`)
    }
    console.log(`  ${''.padEnd(20)} ${''.padStart(6)}            ${birr(total).padStart(14)} in total, owed and unpaid`)
    console.log('  The window cannot return this — their marker is already past it, and')
    console.log('  an undo is not available either: the descriptor markUserPaid returns lives')
    console.log('  in the admin screen that made the payment and is gone once that tab is.')
    console.log('  So this is a transfer to make by hand.')
    console.log('')
    console.log('  Rolling referral_pay_marker back to the previous payout would put it on the')
    console.log('  dashboard to be paid the usual way, but it would also re-owe the commission')
    console.log('  that payout DID contain — the members whose windows were never cut — so it')
    console.log('  overpays by a little. Paying the figure above is the exact answer.')
  }

  // ── the regression ────────────────────────────────────────────────────────
  console.log()
  if (buriedRows.length && cutByWorker.length === 0 && settled.length === 0) {
    console.log('FAIL: a worker is still cutting somebody else\'s commission.')
    process.exit(1)
  }
  console.log(
    cutByWorker.length === 0 && rows.every((r) => r.owed_now >= r.owed_old)
      ? 'OK: no commission window is closed by anything but its own referrer being paid.'
      : 'OK: the window is now the referrer\'s own payout only.'
  )
} finally {
  await db.end()
}
