// Find the "null" comments workers pasted, by reading the links they were handed nothing for.
//   node scripts/run-ts-check.mjs scripts/find-null-comments.ts [days=10] [out.csv]
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
async function main(): Promise<void> {
  const days = Number(process.argv[2]) || 10
  const out = process.argv[3] || ''
  const db = await import('../lib/db')
  const { fetchComments } = await import('../lib/linkStats')
  // Every click handed no comment and no product: where a bubble-app user got "null".
  const { rows } = await db.pool.query<{
    url: string; user_id: string; clicked_at: Date; name: string | null; handle: string | null
  }>(
    `SELECT c.url, c.user_id, c.clicked_at, p.name,
            lower(substring(p.tiktok_url from '@([^/?#]+)')) AS handle
       FROM clicked_link c LEFT JOIN user_profile p ON p.user_id = c.user_id
      WHERE c.clicked_at > now() - ($1::int || ' days')::interval
        AND c.product IS NULL AND c.served_comment IS NULL
      ORDER BY c.clicked_at`,
    [days]
  )
  const byUrl = new Map<string, typeof rows>()
  for (const r of rows) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r])
  const tiktok = Array.from(byUrl.keys()).filter((u) => u.includes('tiktok.com'))
  console.log(`${rows.length} clicks handed no comment in ${days} days, on ${byUrl.size} links (${tiktok.length} TikTok, readable)`)

  // Handle -> worker, for naming whoever wrote "null" (any worker, not only the clicker).
  const { rows: users } = await db.pool.query<{ handle: string; name: string }>(
    `SELECT lower(substring(tiktok_url from '@([^/?#]+)')) AS handle, name FROM user_profile WHERE tiktok_url IS NOT NULL`)
  const nameOf = new Map(users.filter((u) => u.handle).map((u) => [u.handle, u.name]))

  const found: { url: string; handle: string; worker: string; posted: string }[] = []
  let read = 0, unread = 0, i = 0
  const worker = async () => {
    for (;;) {
      const url = tiktok[i++]
      if (!url) return
      const r = await fetchComments(url, 6).catch(() => null)
      if (!r || r.unresolved) { unread++; continue }
      read++
      for (const c of r.comments) {
        if (c.text.trim().toLowerCase() !== 'null') continue
        found.push({ url, handle: c.username, worker: nameOf.get(c.username) ?? '(not a worker)', posted: c.postedAt ?? '' })
      }
      if ((read + unread) % 50 === 0) console.log(`  ${read + unread}/${tiktok.length} read, ${found.length} "null" so far`)
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))

  found.sort((a, b) => a.worker.localeCompare(b.worker) || a.posted.localeCompare(b.posted))
  console.log(`\nread ${read} links (${unread} unreadable). "null" comments found: ${found.length}`)
  const linksWith = new Set(found.map((f) => f.url))
  console.log(`TikTok links carrying at least one "null": ${linksWith.size} of ${tiktok.length}`)
  // Each TikTok click handed nothing: is THAT worker's "null" on that link?
  const has = new Set(found.map((f) => `${f.handle}|${f.url}`))
  const ttClicks = rows.filter((r) => r.url.includes('tiktok.com'))
  const matched = ttClicks.filter((r) => r.handle && has.has(`${r.handle}|${r.url}`)).length
  console.log(`TikTok clicks handed nothing: ${ttClicks.length}; the clicker's own "null" is on the link for ${matched}`)
  const perLink = new Map<string, number>()
  for (const f of found) perLink.set(f.url, (perLink.get(f.url) ?? 0) + 1)
  const counts = Array.from(perLink.values()).sort((a, b) => b - a)
  console.log(`"null" comments per link: most ${counts[0] ?? 0}, median ${counts[Math.floor(counts.length / 2)] ?? 0}`)
  const per = new Map<string, number>()
  for (const f of found) per.set(`${f.worker} (@${f.handle})`, (per.get(`${f.worker} (@${f.handle})`) ?? 0) + 1)
  for (const [w, n] of Array.from(per.entries()).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${w}`)
  if (out) {
    writeFileSync(out, 'worker,tiktok,posted,url\n' +
      found.map((f) => [f.worker, '@' + f.handle, f.posted, f.url].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n'))
    console.log(`\nwritten to ${out}`)
  }
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
