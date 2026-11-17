// The verify page's Active % for one genre, computed as /api/admin/links/channel-stats
// does, timed — to see whether it is empty, slow, or keyed differently from the rows.
//   node scripts/run-ts-check.mjs scripts/probe-channel-stats.ts [genre]
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const genre = process.argv[2] || 'humanizer'
  const t0 = Date.now()
  const { pool } = await import('../lib/db')
  const { loadVideosJson } = await import('../lib/videos')
  const { channelOfRow, siteOf } = await import('../lib/channelRank')
  const { genreOfRow, genreInScope } = await import('../lib/config')
  const { rows: staged } = await pool.query<{ platform: string; account: string }>(
    `SELECT DISTINCT coalesce(platform,'tiktok') platform, lower(ltrim(account,'@')) account
       FROM verify_link WHERE account <> '' AND coalesce(genre,'humanizer') = $1`, [genre])
  const wanted = new Set(staged.map((r) => `${r.platform}:${r.account}`))
  console.log(`${wanted.size} staged channels (${Date.now() - t0} ms)`)
  const t1 = Date.now()
  const videos = await loadVideosJson()
  console.log(`pool loaded: ${videos.length} rows in ${Date.now() - t1} ms`)
  let hits = 0
  const seen = new Set<string>()
  for (const v of videos) {
    if (!genreInScope(genre, genreOfRow(v))) continue
    const url = String((v as { url?: unknown }).url ?? '')
    const ch = channelOfRow(url, (v as { author?: unknown }).author)
    if (!ch) continue
    const k = `${siteOf(url)}:${ch}`
    if (wanted.has(k)) { hits++; seen.add(k) }
  }
  console.log(`pool links of those channels: ${hits}; channels with any: ${seen.size} of ${wanted.size}`)
  console.log('sample staged keys:', Array.from(wanted).slice(0, 5))
  console.log(`total ${Date.now() - t0} ms`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
