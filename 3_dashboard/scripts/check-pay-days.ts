// 💸 Paid out — last 10 payment days: the log, its one-time backfill from the
// pre-payment snapshots, and that a logged payment's undo removes it.
//   node scripts/run-ts-check.mjs scripts/check-pay-days.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const { pool, getRecentPayDays } = await import('../lib/db')
  const days = await getRecentPayDays(10)
  for (const d of days) {
    console.log(`  ${d.day}  ${String(d.total).padStart(10)} birr  ${d.workers} worker(s)  top: ${d.people.slice(0, 2).map((p) => `${p.name} ${p.amount}`).join(', ')}`)
  }
  const { rows } = await pool.query<{ source: string; n: number }>('SELECT source, count(*)::int AS n FROM pay_log GROUP BY 1')
  console.log('pay_log rows:', rows)
  const ok = days.length > 0 && days.length <= 10 && days.every((d, i) => i === 0 || days[i - 1].day > d.day)
  console.log(ok ? 'all correct' : 'FAILED')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
