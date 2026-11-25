// Puts every worker who posted "null" into comment removal mode for those links,
// plus the owner's test account on one link.
//   node scripts/run-ts-check.mjs scripts/load-null-removals.ts <null-comments.csv>
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
async function main(): Promise<void> {
  const csv = process.argv[2]
  if (!csv) throw new Error('pass the CSV path')
  const R = await import('../lib/commentRemoval')
  const db = await import('../lib/db')
  const r = await R.addRemovalsFromText(readFileSync(csv, 'utf8'), 'null')
  console.log(`workers' rows added: ${r.added}; skipped: ${r.skipped.length}`)
  for (const s of r.skipped) console.log('  skipped:', s)
  const t = await R.addRemovalsFromText(
    'kirubelman3@gmail.com https://www.tiktok.com/@essaydone/video/7707619651739487518',
    'null'
  )
  console.log(`test account rows added: ${t.added}`)
  const all = (await R.listRemovals()).filter((x) => !x.doneAt)
  const people = new Set(all.map((x) => x.userId))
  console.log(`pending now: ${all.length} links across ${people.size} accounts`)
  await db.pool.end().catch(() => {})
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
