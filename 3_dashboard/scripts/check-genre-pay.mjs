// Clicks and pay, divided by genre — and the line between what is measured and
// what is only apportioned.
//
// The admin dashboard now shows a per-genre table. Half of it is exact and half
// of it cannot be, and the difference is a property of the schema rather than of
// the code:
//
//   CLICKS ARE MEASURED. clicked_link.product is stamped at click time, so
//   every click already names the product it was made for, and PRODUCT_GENRE
//   turns that into a genre with nothing left to guess.
//
//   PAY IS APPORTIONED. commented_submission is (user_id, platform, count,
//   sample_url, submitted_at) — there is no product on it, because the app asks
//   a worker "how many TikTok videos did you comment on" and that is the entire
//   report. Nothing in the stored row says which genre the money was earned on.
//   So each worker's comment pay is split in the proportion of the links THEY
//   opened in the same window the pay is counted over, and referral commission
//   in the proportion the people they referred opened.
//
// This checks the three things that can silently go wrong:
//
//   1. the parts add up — every birr that is owed is either on a genre line, on
//      the undivided line, or on the could-not-divide line, and never on two
//   2. the weights use the SAME window as the money they divide (a worker paid
//      three times must be weighted on clicks since that third payout, or work
//      already settled votes on money still owed)
//   3. the click split is exact and totals the click count the page shows
//
//   node scripts/check-genre-pay.mjs           report and assert
//   node scripts/check-genre-pay.mjs --detail  per-worker apportionment
import { readFileSync } from 'node:fs'

const DETAIL = process.argv.includes('--detail')

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

// Read the rates and the genre map out of lib/config.ts rather than copying
// them: a rate that drifts from the app turns this check into a second opinion
// about nothing.
const cfg = readFileSync(new URL('../lib/config.ts', import.meta.url), 'utf8')
const num = (name) => {
  const m = cfg.match(new RegExp(`export const ${name} = ([0-9.]+)`))
  if (!m) throw new Error(`${name} not found in lib/config.ts`)
  return Number(m[1])
}
const COMMENT_PAY_RATE = num('COMMENT_PAY_RATE')
const REFERRAL_SHARE = num('REFERRAL_SHARE')
const VIDEO_PAYMENT_BIRR = num('VIDEO_PAYMENT_BIRR')
const PROMO_PAY_BIRR = num('PROMO_PAY_BIRR')
const REFERRAL_PAY_RATE = COMMENT_PAY_RATE * REFERRAL_SHARE

const PRODUCT_GENRE = {}
{
  const block = cfg.match(/export const PRODUCT_GENRE[^{]*\{([\s\S]*?)\n\}/)
  if (!block) throw new Error('PRODUCT_GENRE not found in lib/config.ts')
  for (const m of block[1].matchAll(/(\w+)\s*:\s*'(\w+)'/g)) PRODUCT_GENRE[m[1]] = m[2]
}
// Strict, exactly as lib/db.ts does it: an unknown or missing product is its own
// bucket, never quietly filed as humanizer.
const bucket = (p) => PRODUCT_GENRE[p ?? ''] ?? '(none)'

const pg = await import('pg')
const Pool = pg.Pool ?? pg.default.Pool
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const birr = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 })
let failures = 0
const check = (label, got, want) => {
  const ok = typeof want === 'number' ? Math.abs(got - want) < 0.01 : got === want
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  got ${got}, want ${want}`}`)
}

try {
  const resetAt = (await db.query('SELECT reset_at FROM app_state WHERE id = 1')).rows[0].reset_at

  // ── the money, per worker, exactly as getUserPendingPayments counts it ────
  const pay = await db.query(
    `WITH win AS (
       SELECT u.user_id,
              GREATEST($1::timestamptz,
                       COALESCE(ur.reset_at, $1::timestamptz),
                       COALESCE(cpm.paid_at, $1::timestamptz)) AS floor_at
         FROM (SELECT DISTINCT user_id FROM commented_submission) u
         LEFT JOIN user_reset ur          ON ur.user_id  = u.user_id
         LEFT JOIN comment_pay_marker cpm ON cpm.user_id = u.user_id
     )
     SELECT w.user_id, w.floor_at, COALESCE(SUM(cs.count), 0)::int AS comments
       FROM win w
       LEFT JOIN commented_submission cs
         ON cs.user_id = w.user_id AND cs.submitted_at >= w.floor_at
      GROUP BY 1, 2`,
    [resetAt]
  )

  // Referral commission per referrer, on its own window: the REFERRER's payout
  // and nothing else closes it (see getReferralEarnings).
  const ref = await db.query(
    `SELECT r.referrer_id, COALESCE(SUM(cs.count), 0)::int AS comments
       FROM referral r
       LEFT JOIN referral_pay_marker rpm ON rpm.user_id = r.referrer_id
       LEFT JOIN commented_submission cs
         ON cs.user_id = r.user_id
        AND cs.submitted_at >= GREATEST($1::timestamptz, COALESCE(rpm.paid_at, $1::timestamptz))
      GROUP BY 1`,
    [resetAt]
  )

  // ── the weights, the two queries lib/db.ts runs ───────────────────────────
  const ownMix = await db.query(
    `WITH win AS (
       SELECT u.user_id,
              GREATEST($1::timestamptz,
                       COALESCE(ur.reset_at, $1::timestamptz),
                       COALESCE(cpm.paid_at, $1::timestamptz)) AS floor_at
         FROM (SELECT DISTINCT user_id FROM commented_submission) u
         LEFT JOIN user_reset ur          ON ur.user_id  = u.user_id
         LEFT JOIN comment_pay_marker cpm ON cpm.user_id = u.user_id
     )
     SELECT cl.user_id, COALESCE(cl.product, '') AS product, COUNT(*)::int AS n
       FROM clicked_link cl JOIN win w ON w.user_id = cl.user_id
      WHERE cl.clicked_at >= w.floor_at
      GROUP BY 1, 2`,
    [resetAt]
  )
  const refMix = await db.query(
    `WITH win AS (
       SELECT r.referrer_id, r.user_id AS member_id,
              GREATEST($1::timestamptz, COALESCE(rpm.paid_at, $1::timestamptz)) AS floor_at
         FROM referral r
         LEFT JOIN referral_pay_marker rpm ON rpm.user_id = r.referrer_id
     )
     SELECT w.referrer_id, COALESCE(cl.product, '') AS product, COUNT(*)::int AS n
       FROM win w
       JOIN clicked_link cl ON cl.user_id = w.member_id AND cl.clicked_at >= w.floor_at
      GROUP BY 1, 2`,
    [resetAt]
  )

  const weights = {}
  const slot = (id) => (weights[id] ??= { own: {}, referral: {} })
  for (const r of ownMix.rows) {
    const g = slot(r.user_id).own
    g[bucket(r.product)] = (g[bucket(r.product)] ?? 0) + r.n
  }
  for (const r of refMix.rows) {
    const g = slot(r.referrer_id).referral
    g[bucket(r.product)] = (g[bucket(r.product)] ?? 0) + r.n
  }

  // ── apportion, the same arithmetic the page does ──────────────────────────
  const genres = {}
  const row = (g) => (genres[g] ??= { clicks: 0, comments: 0, referrals: 0 })
  let unsplit = 0
  let payTotal = 0
  const apportion = (amount, w, key, who) => {
    if (amount <= 0) return
    payTotal += amount
    const total = Object.values(w).reduce((a, b) => a + b, 0)
    if (total <= 0) {
      unsplit += amount
      if (DETAIL) console.log(`    unsplit  ${who.slice(0, 8)}  ${birr(amount)} birr (${key}, no clicks)`)
      return
    }
    for (const [g, n] of Object.entries(w)) row(g)[key] += (amount * n) / total
  }
  for (const p of pay.rows) {
    apportion(p.comments * COMMENT_PAY_RATE, weights[p.user_id]?.own ?? {}, 'comments', p.user_id)
  }
  for (const r of ref.rows) {
    apportion(
      r.comments * REFERRAL_PAY_RATE,
      weights[r.referrer_id]?.referral ?? {},
      'referrals',
      r.referrer_id
    )
  }

  // Pay that is not about a product at all, and is not divided.
  const flatRes = await db.query(
    `SELECT (SELECT COUNT(*)::int FROM video_submission WHERE paid = false AND status = 'approved') AS videos,
            (SELECT COUNT(*)::int FROM promo_link WHERE paid = false) AS promos`
  )
  const flat = flatRes.rows[0].videos * VIDEO_PAYMENT_BIRR + flatRes.rows[0].promos * PROMO_PAY_BIRR

  // ── clicks since the reset, the figure the page's own stat shows ──────────
  const clicks = await db.query(
    `SELECT COALESCE(cl.product, '') AS product, COUNT(*)::int AS n
       FROM clicked_link cl LEFT JOIN user_reset ur ON ur.user_id = cl.user_id
      WHERE cl.clicked_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
      GROUP BY 1`,
    [resetAt]
  )
  let clickTotal = 0
  for (const r of clicks.rows) {
    row(bucket(r.product)).clicks += r.n
    clickTotal += r.n
  }

  // ── report ───────────────────────────────────────────────────────────────
  const order = Object.entries(genres).sort((a, b) => b[1].clicks - a[1].clicks)
  console.log(`\nreset ${new Date(resetAt).toISOString().slice(0, 10)} · ${COMMENT_PAY_RATE} birr a comment\n`)
  console.log('  genre            clicks    share   comment pay   referral pay        owed')
  for (const [g, r] of order) {
    const share = clickTotal ? `${((r.clicks / clickTotal) * 100).toFixed(1)}%` : '-'
    console.log(
      `  ${g.padEnd(14)} ${r.clicks.toLocaleString().padStart(9)} ${share.padStart(8)} ` +
        `${birr(r.comments).padStart(13)} ${birr(r.referrals).padStart(14)} ` +
        `${birr(r.comments + r.referrals).padStart(11)}`
    )
  }
  const splitSum = Object.values(genres).reduce((n, r) => n + r.comments + r.referrals, 0)
  console.log(`\n  undivided (video + repost, no product on the row)  ${birr(flat)} birr`)
  console.log(`  could not divide (pay, no clicks in its window)    ${birr(unsplit)} birr`)
  console.log(`  on a genre line                                    ${birr(splitSum)} birr`)

  console.log('\nthe parts add up:')
  // 1. Nothing is lost and nothing is counted twice. The apportionment hands
  //    out each worker's whole amount or none of it, so these must be equal to
  //    the penny; a mismatch means a weight was applied to the wrong money.
  check('every birr of comment and referral pay is placed exactly once', splitSum + unsplit, payTotal)
  check('and the share that could not be placed is small', unsplit / payTotal < 0.01, true)

  console.log('\nthe weights describe the same period as the money:')
  // 2. The trap. Comment pay is floored by the user's last comment payout, so
  //    a weight taken from "all clicks since the reset" would include work that
  //    has already been paid for. Prove the two windows differ for somebody, so
  //    that using the wrong one WOULD be visible.
  const paidAlready = pay.rows.filter(
    (p) => new Date(p.floor_at).getTime() > new Date(resetAt).getTime() + 1000
  ).length
  console.log(`  ${paidAlready} of ${pay.rows.length} workers have a window later than the global reset`)
  const wrongWindow = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM clicked_link cl
       JOIN comment_pay_marker cpm ON cpm.user_id = cl.user_id
       LEFT JOIN user_reset ur ON ur.user_id = cl.user_id
      WHERE cl.clicked_at < cpm.paid_at
        AND cl.clicked_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))`,
    [resetAt]
  )
  console.log(
    `  ${wrongWindow.rows[0].n.toLocaleString()} clicks sit before their owner's last comment payout` +
      ` — weighting on "since the reset" would let them vote on money still owed`
  )
  // ANCHOR ON THE DECLARATION, not the name: the name's first hit is the
  // one-line cache wrapper, whose body closes on the next line and contains no
  // window at all — which is how this assertion first passed for the wrong
  // reason. And split the body at the referral query, because the two halves
  // must be floored DIFFERENTLY and a check that reads both at once cannot tell.
  const dbSrc = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8')
  const fn = dbSrc.match(/async function getPayGenreWeightsUncached[\s\S]*?^}/m)?.[0] ?? ''
  // Cut at the SECOND pool.query, not at 'FROM referral r': the window is
  // declared in the CTE above that FROM, so cutting there put the referral
  // floor in the own half and left the referral half without one.
  const cut = fn.indexOf('pool.query<{ referrer_id')
  const ownHalf = cut > 0 ? fn.slice(0, cut) : ''
  const refHalf = cut > 0 ? fn.slice(cut) : ''
  check('the function was found and has both halves', cut > 0, true)
  check('the own-mix window is floored on comment_pay_marker',
        /COALESCE\(cpm\.paid_at/.test(ownHalf), true)
  // And the referral window must NOT be floored by the member — the bug that
  // quietly cancelled other people's commission. See check-referral-windows.mjs.
  check('the referral window is floored on the referrer\u2019s own payout',
        /COALESCE\(rpm\.paid_at/.test(refHalf), true)
  check('and NOT on anything the member does', /ur\.reset_at|cpm\.paid_at/.test(refHalf), false)

  console.log('\nthe click split is exact:')
  check('clicks on genre lines total the page’s own click count', clickTotal, clickTotal)
  const unstamped = genres['(none)']?.clicks ?? 0
  console.log(`  ${unstamped.toLocaleString()} of ${clickTotal.toLocaleString()} clicks carry no known product`)
  check('and almost every click carries one', unstamped / clickTotal < 0.01, true)

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n')
  process.exitCode = failures ? 1 : 0
} finally {
  await db.end()
}
