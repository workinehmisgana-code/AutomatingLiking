// Comment removal mode, end to end on the owner's test account (rows are removed afterwards).
//   node scripts/run-ts-check.mjs scripts/check-comment-removal.ts
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
async function main(): Promise<void> {
  const db = await import('../lib/db')
  const R = await import('../lib/commentRemoval')
  let bad = 0
  const ok = (c: boolean, w: string) => { console.log((c ? 'ok     ' : 'FAILED ') + w); if (!c) bad++ }

  const { rows: u } = await db.pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM "user" WHERE lower(email) = 'kirubelman3@gmail.com'`)
  if (!u[0]) throw new Error('test account not found')
  const me = u[0].id
  // A real link with "null" comments on it (by other workers, not this account).
  const link = 'https://www.tiktok.com/@essaydone/video/7707619651739487518'
  const before = await R.pendingRemovals(me)
  ok(before.length === 0, 'test account starts in normal mode')

  const r = await R.addRemovalsFromText(
    `worker,tiktok,posted,url\n"Test","x","2026",${link}, kirubelman3@gmail.com\n@no_such_worker_zz https://www.tiktok.com/@a/video/1`,
    'null'
  )
  ok(r.added === 1, `CSV-style line added by email, header skipped (added ${r.added})`)
  ok(r.skipped.length === 1, 'unknown worker reported back, not guessed')
  const pend = await R.pendingRemovals(me)
  ok(pend.length === 1 && pend[0].matchText === 'null', 'now in removal mode with the link and the text to find')
  ok(await R.inRemovalMode(me), 'inRemovalMode says so (links and clicks are refused)')

  const c = await R.checkRemoval(me, pend[0].id)
  console.log('  check:', JSON.stringify(c))
  ok(!!c && c.done && c.remaining === 0, 'their account has no "null" on it -> crossed off, none left')
  ok(!(await R.inRemovalMode(me)), 'back to normal mode')
  const row = (await R.listRemovals()).find((x) => x.id === pend[0].id)
  ok(!!row?.doneAt && (row.doneHow === 'verified' || row.doneHow === 'worker'), `admin list shows it done (${row?.doneHow})`)

  await R.deleteRemovals([pend[0].id])
  ok(!(await R.listRemovals()).some((x) => x.id === pend[0].id), 'cleaned up')
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
