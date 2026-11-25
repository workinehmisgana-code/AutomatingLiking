// Which genres' links are served on which platform: only those with a comment to give.
//   node scripts/run-ts-check.mjs scripts/check-comment-coverage.ts
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
async function main(): Promise<void> {
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const { commentCoverage, serveCommentReliably } = await import('../lib/serveComment')
  const { GENRES } = await import('../lib/config')
  const { productsWithComments } = await import('../lib/db')
  let bad = 0
  const ok = (c: boolean, w: string) => { console.log((c ? 'ok     ' : 'FAILED ') + w); if (!c) bad++ }

  const can = await commentCoverage()
  const sample: Record<string, string> = {
    tiktok: 'https://www.tiktok.com/@a/video/1',
    youtube_shorts: 'https://www.youtube.com/shorts/abc',
    youtube_videos: 'https://www.youtube.com/watch?v=abc',
    instagram: 'https://www.instagram.com/p/abc/',
    reddit: 'https://www.reddit.com/r/x/comments/abc/t/',
  }
  console.log('banked products:', Array.from(await productsWithComments()).join(', '))
  console.log('\n' + 'genre'.padEnd(14) + Object.keys(sample).map((p) => p.padEnd(15)).join(''))
  for (const g of GENRES) {
    console.log(g.padEnd(14) + Object.values(sample).map((u) => (can(g, u) ? 'served' : '— held').padEnd(15)).join(''))
  }
  ok(can('humanizer', sample.tiktok), 'humanizer TikTok links are served')

  // Every served genre/platform really does get a comment: try one live link each.
  const db = await import('../lib/db')
  const { genreOfUrl } = await import('../lib/videos')
  const { rows } = await db.pool.query<{ url: string }>(
    `SELECT DISTINCT ON (platform) url FROM clicked_link WHERE clicked_at > now() - interval '1 day' AND product IS NOT NULL`)
  for (const r of rows) {
    const g = await genreOfUrl(r.url)
    if (!can(g, r.url)) continue
    const s = await serveCommentReliably(r.url)
    ok(!!s.comment, `${g} ${r.url.slice(0, 60)} -> ${s.product}: ${(s.comment ?? 'NOTHING').slice(0, 50)}`)
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
