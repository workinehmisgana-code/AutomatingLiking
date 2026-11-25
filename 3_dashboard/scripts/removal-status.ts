// Comment removal: per worker, how many links are waiting / still there / done, and when checks ran.
//   node scripts/run-ts-check.mjs scripts/removal-status.ts
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
async function main(): Promise<void> {
  const db = await import('../lib/db')
  const { rows } = await db.pool.query(
    `SELECT u.name, count(*) FILTER (WHERE r.done_at IS NULL AND r.checked_at IS NULL)::int waiting,
            count(*) FILTER (WHERE r.done_at IS NULL AND r.checked_at IS NOT NULL)::int still,
            count(*) FILTER (WHERE r.done_at IS NOT NULL)::int done,
            min(r.checked_at) first_check, max(r.checked_at) last_check
       FROM comment_removal r JOIN "user" u ON u.id = r.user_id
      GROUP BY u.name ORDER BY still DESC, done DESC`)
  console.table(rows.map((r: any) => ({ ...r, first_check: r.first_check?.toISOString(), last_check: r.last_check?.toISOString() })))
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
