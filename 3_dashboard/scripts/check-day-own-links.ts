// The "with the worker's own comment" modal must list exactly as many links as
// the table's cell says. Compares getDayOwnLinks to getAdminData's counts for
// every day, on the TikTok platform row and each product row.
//   node scripts/run-ts-check.mjs scripts/check-day-own-links.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const { getAdminData, getDayOwnLinks } = await import('../lib/db')
  const data = await getAdminData(null)
  let bad = 0
  let checked = 0
  for (const t of data.dailyTiktokLinks ?? []) {
    const list = await getDayOwnLinks(t.day, null, null)
    checked++
    if (list.length !== t.withOwn) {
      bad++
      console.log(`tiktok ${t.day}: table ${t.withOwn}, modal ${list.length}`)
    }
  }
  for (const [p, series] of Object.entries(data.dailyTiktokLinksByProduct ?? {})) {
    for (const t of series) {
      if (!t.withOwn) continue
      const list = await getDayOwnLinks(t.day, p, null)
      checked++
      if (list.length !== t.withOwn) {
        bad++
        console.log(`${p} ${t.day}: table ${t.withOwn}, modal ${list.length}`)
      }
    }
  }
  const sample = (data.dailyTiktokLinks ?? []).find((t) => t.withOwn > 0)
  if (sample) {
    const list = await getDayOwnLinks(sample.day, null, null)
    console.log(`sample ${sample.day}:`, list.slice(0, 3).map((r) => `${r.url} ${r.handles.join(',')}`))
  }
  console.log(bad ? `${bad} of ${checked} cells differ` : `all ${checked} cells match`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
