// How current is the scan the ratio rule reads, per genre? For links clicked in
// the last 7 days: never scanned, scanned before the latest click (the
// comments posted since are not counted), scanned after it.
//   node scripts/run-ts-check.mjs scripts/probe-ratio-stale.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const { pool } = await import('../lib/db')
  const { genreOfProduct } = await import('../lib/config')
  const { rows } = await pool.query<{ url: string; product: string; clicks: number; last_click: Date; scanned_at: Date | null; our_count: number | null; denom: number | null }>(
    `SELECT c.url, max(c.product) AS product, count(*)::int AS clicks, max(c.clicked_at) AS last_click,
            s.scanned_at, s.our_count, GREATEST(COALESCE(s.total_count,0), s.read_count, s.our_count, 1) AS denom
       FROM clicked_link c LEFT JOIN link_comment_scan s ON s.url = c.url
      WHERE c.clicked_at > now() - interval '7 days' AND c.url LIKE '%tiktok.com%'
      GROUP BY c.url, s.scanned_at, s.our_count, s.total_count, s.read_count`)
  const st: Record<string, { links: number; never: number; stale: number; fresh: number; ages: number[]; ex: string[] }> = {}
  for (const r of rows) {
    const g = r.product ? genreOfProduct(r.product) : '?'
    const x = (st[g] ??= { links: 0, never: 0, stale: 0, fresh: 0, ages: [], ex: [] })
    x.links++
    if (!r.scanned_at) x.never++
    else if (r.scanned_at < r.last_click) {
      x.stale++
      x.ages.push((Date.now() - r.scanned_at.getTime()) / 864e5)
      if (x.ex.length < 4 && r.clicks >= 3)
        x.ex.push(`${r.url} clicks7d=${r.clicks} scan says ${r.our_count}/${r.denom} on ${r.scanned_at.toISOString().slice(0, 10)}`)
    } else x.fresh++
  }
  for (const [g, x] of Object.entries(st)) {
    const a = x.ages.sort((p, q) => p - q)
    const med = a.length ? a[a.length >> 1].toFixed(1) : '-'
    console.log(`\n${g}: ${x.links} clicked links (7d) · never scanned ${x.never} · scanned BEFORE the last click ${x.stale} (median scan age ${med} d) · scanned after ${x.fresh}`)
    x.ex.forEach((e) => console.log('   ', e))
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
