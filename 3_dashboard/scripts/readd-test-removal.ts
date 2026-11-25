// Put the owner's test account (kirubelman3) back into removal mode on its test link.
//   node scripts/run-ts-check.mjs scripts/readd-test-removal.ts
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
async function main(): Promise<void> {
  const db = await import('../lib/db')
  const R = await import('../lib/commentRemoval')
  const { rows } = await db.pool.query<{ id: string; name: string | null; tiktok_url: string | null }>(
    `SELECT u.id, u.name, p.tiktok_url FROM "user" u LEFT JOIN user_profile p ON p.user_id = u.id
      WHERE lower(u.email) = 'kirubelman3@gmail.com'`)
  console.log('test account:', rows[0]?.name, rows[0]?.tiktok_url)
  const r = await R.addRemovalsFromText(
    'kirubelman3@gmail.com https://www.tiktok.com/@essaydone/video/7707619651739487518', 'null')
  console.log('re-added:', r.added, 'pending now:', (await R.pendingRemovals(rows[0].id)).length)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
