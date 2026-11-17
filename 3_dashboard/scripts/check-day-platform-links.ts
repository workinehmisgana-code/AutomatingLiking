// The "by platform" cells of 📈 Links clicked per day open their links: for
// each platform, the links returned for a day add up to that day's count.
//   node scripts/run-ts-check.mjs scripts/check-day-platform-links.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const { pool, getDayPlatformLinks } = await import('../lib/db')
  const { rows } = await pool.query<{ day: string; platform: string; n: number }>(
    `SELECT clicked_at::date::text AS day, COALESCE(NULLIF(platform, ''), '(none)') AS platform, count(*)::int AS n
       FROM clicked_link WHERE clicked_at::date >= CURRENT_DATE - 6 GROUP BY 1, 2 ORDER BY 1 DESC, 2`)
  let bad = 0
  for (const r of rows.filter((x) => x.platform === 'reddit' || x.day === rows[0].day)) {
    const links = await getDayPlatformLinks(r.day, r.platform, null)
    const sum = links.reduce((n, l) => n + l.clicks, 0)
    const ok = sum === r.n
    if (!ok) bad++
    console.log(`  ${ok ? 'ok    ' : 'FAILED'} ${r.day} ${r.platform.padEnd(15)} count ${r.n}, links ${links.length}, clicks ${sum}`)
    if (r.platform === 'reddit' && links[0]) {
      console.log(`         e.g. ${links[0].url}\n         by ${links[0].workers.join(', ')} | ${links[0].comments[0] ?? '(no comment)'}`)
    }
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
