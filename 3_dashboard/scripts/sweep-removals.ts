// Check every TikTok comment-removal row against the video, by the worker's TikTok
// username: gone -> crossed off; still there -> on their list (even if they ticked it).
//   node scripts/run-ts-check.mjs scripts/sweep-removals.ts [null-comments.csv to fill in usernames]
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
async function main(): Promise<void> {
  const db = await import('../lib/db')
  const R = await import('../lib/commentRemoval')
  await R.pendingRemovals('-') // creates the handle column
  const csv = process.argv[2]
  if (csv) {
    let n = 0
    for (const line of readFileSync(csv, 'utf8').split('\n').slice(1)) {
      const url = line.match(/https?:\/\/[^\s",]+/)?.[0]
      const at = line.match(/"@([A-Za-z0-9._]+)"/)?.[1]
      if (!url || !at) continue
      const { rowCount } = await db.pool.query(
        `UPDATE comment_removal r SET handle = $1 FROM user_profile p
          WHERE r.url = $2 AND r.handle IS NULL AND p.user_id = r.user_id
            AND lower(substring(p.tiktok_url from '@([^/?#]+)')) = $1`,
        [at.toLowerCase(), url])
      n += rowCount ?? 0
    }
    console.log(`usernames filled in: ${n}`)
  }
  const r = await R.sweepRemovals({
    concurrency: 4,
    onProgress: (d, t) => { if (d % 25 === 0 || d === t) console.log(`  ${d}/${t}`) },
  })
  console.log(JSON.stringify(r))
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
