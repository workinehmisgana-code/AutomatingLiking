// The last 10 payment days, split by genre: each day's genres add up to its total.
//   node scripts/run-ts-check.mjs scripts/check-pay-days-genre.ts
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
async function main(): Promise<void> {
  const { getRecentPayDays, apportionPayByGenre } = await import('../lib/db')
  let bad = 0
  const ok = (c: boolean, w: string) => { console.log((c ? 'ok     ' : 'FAILED ') + w); if (!c) bad++ }

  const a = apportionPayByGenre({ comments: 100, referrals: 20, total: 150 },
    { own: { humanizer: 3, slides: 1 }, referral: { humanizer: 1 } })
  ok(a.humanizer === 95 && a.slides === 25 && a.other === 30, `apportioned like the pay card: ${JSON.stringify(a)}`)
  const b = apportionPayByGenre({ comments: 40, referrals: 0, total: 40 }, { own: {} })
  ok(b.unsplit === 40, `no links to divide by -> 'unsplit', not guessed: ${JSON.stringify(b)}`)

  const days = await getRecentPayDays(10)
  console.log(`\n${days.length} payment days:`)
  for (const d of days) {
    const s = Object.values(d.byGenre).reduce((x, y) => x + y, 0)
    const parts = Object.entries(d.byGenre).sort((x, y) => y[1] - x[1]).map(([g, v]) => `${g} ${v}`).join(' · ')
    console.log(`  ${d.day}  ${d.total} birr${d.estimated ? ' (≈)' : ''}  ->  ${parts}`)
    ok(Math.abs(s - d.total) <= 0.05 * Math.max(1, d.workers), `  ${d.day}: genres add up to the total (${s.toFixed(2)} vs ${d.total})`)
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
