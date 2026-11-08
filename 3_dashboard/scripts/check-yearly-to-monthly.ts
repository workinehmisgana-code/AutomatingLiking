// No DB, no provider: the yearly → monthly refund arithmetic.
//   node scripts/run-ts-check.mjs scripts/check-yearly-to-monthly.ts
import { addMonths, quoteYearlyToMonthly } from '../lib/support/intervalDowngrade'

let bad = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

const q = (paidAt: string, now: string) =>
  quoteYearlyToMonthly({ paidAt, paid: 9600, monthly: 1200, now: new Date(now) })

eq('same day → 1 month kept, $84 back', [q('2026-01-10T12:00:00Z', '2026-01-10T13:00:00Z').monthsUsed, q('2026-01-10T12:00:00Z', '2026-01-10T13:00:00Z').difference], [1, 8400])
eq('2.5 months → 3 kept, $60 back', [q('2026-01-10T12:00:00Z', '2026-03-25T00:00:00Z').monthsUsed, q('2026-01-10T12:00:00Z', '2026-03-25T00:00:00Z').difference], [3, 6000])
eq('paid through', q('2026-01-10T12:00:00Z', '2026-03-25T00:00:00Z').paidThrough, '2026-04-10T12:00:00.000Z')
eq('exactly 1 month in → month 2 started', q('2026-01-10T12:00:00Z', '2026-02-10T12:00:00Z').monthsUsed, 2)
eq('11.5 months → 12 kept, nothing back', [q('2026-01-10T12:00:00Z', '2026-12-25T00:00:00Z').monthsUsed, q('2026-01-10T12:00:00Z', '2026-12-25T00:00:00Z').difference], [12, 0])
eq('monthly dearer than 1/12 → never negative', quoteYearlyToMonthly({ paidAt: '2026-01-01T00:00:00Z', paid: 1000, monthly: 1200, now: new Date('2026-01-02T00:00:00Z') }).difference, 0)
eq('31 Jan + 1 month clamps to Feb', addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28')

console.log(bad ? `${bad} failed` : 'all good')
process.exit(bad ? 1 : 0)
