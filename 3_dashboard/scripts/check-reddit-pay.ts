// Reddit comments pay COMMENT_PAY_RATE_BY_PLATFORM.reddit (2 birr), every other
// platform COMMENT_PAY_RATE. Checks the pending pay, the per-user and the
// referral sums all weigh Reddit at its own rate.
//   node scripts/run-ts-check.mjs scripts/check-reddit-pay.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const cfg = await import('../lib/config')
  const db = await import('../lib/db')
  let bad = 0
  const check = (label: string, ok: boolean) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`)
    if (!ok) bad++
  }
  check('reddit pays 2 birr', cfg.commentPayRate('reddit') === 2)
  check('tiktok pays the base rate', cfg.commentPayRate('tiktok') === cfg.COMMENT_PAY_RATE)
  check('adjustment rows pay the base rate', cfg.commentPayRate('adjustment') === cfg.COMMENT_PAY_RATE)

  const all = await db.getAllPendingPay()
  let withReddit = 0
  for (const [uid, p] of Object.entries(all)) {
    const r = p.comments.reddit ?? 0
    const want = (p.comments.count - r) * cfg.COMMENT_PAY_RATE + r * 2
    if (Math.abs(p.comments.birr - want) > 0.001) {
      bad++
      console.log(`  FAIL ${uid}: ${p.comments.birr} vs ${want}`)
    }
    if (r > 0) {
      withReddit++
      if (withReddit <= 5) {
        const one = await db.getUserPendingPayments(uid)
        check(
          `${uid.slice(0, 8)}: ${p.comments.count} comments (${r} Reddit) = ${p.comments.birr} birr, single-user read agrees`,
          Math.abs(one.comments.birr - p.comments.birr) < 0.001
        )
      }
    }
  }
  console.log(`  ${Object.keys(all).length} users checked, ${withReddit} with Reddit comments`)

  const refs = await db.getAllReferralEarnings()
  for (const [uid, e] of Object.entries(refs)) {
    const sum = e.members.reduce((a, m) => a + m.birr, 0)
    if (Math.abs(sum - e.birr) > 0.001) {
      bad++
      console.log(`  FAIL referrer ${uid}: ${e.birr} vs members ${sum}`)
    }
    if (e.birr + 0.001 < e.comments * cfg.REFERRAL_PAY_RATE) {
      bad++
      console.log(`  FAIL referrer ${uid}: less than the base-rate commission`)
    }
  }
  console.log(`  ${Object.keys(refs).length} referrers checked`)
  console.log(bad ? `${bad} FAILED` : 'all correct')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
