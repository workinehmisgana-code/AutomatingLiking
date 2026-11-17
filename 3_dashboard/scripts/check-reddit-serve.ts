// The Reddit serving path, end to end: the warm-up writes comments for a couple
// of posts (stored, as the cron does), then serveCommentForUrl is asked for one
// of them — it must return one of THAT post's own comments, and a TikTok link
// must still come from the bank.
//   node scripts/run-ts-check.mjs scripts/check-reddit-serve.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const { pool } = await import('../lib/db')
  const { warmRedditComments, storedRedditComments } = await import('../lib/redditComments')
  const { serveCommentForUrl, productOrderForUrl } = await import('../lib/serveComment')
  let bad = 0
  const ok = (cond: boolean, what: string) => {
    console.log(`  ${cond ? 'ok    ' : 'FAILED'} ${what}`)
    if (!cond) bad++
  }

  const t0 = Date.now()
  const w = await warmRedditComments(2)
  console.log(`warm-up: ${JSON.stringify(w)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  ok(w.written > 0, 'the warm-up wrote comments for at least one post')

  const { rows } = await pool.query<{ url: string; product: string }>(
    'SELECT url, product FROM reddit_post_comment ORDER BY generated_at DESC LIMIT 1')
  const { url, product } = rows[0]
  const own = await storedRedditComments(url, product)
  console.log(`\n${url}\n  ${own.length} stored for ${product}`)
  const { order } = await productOrderForUrl(url)
  const served = await serveCommentForUrl(url)
  console.log(`  served: ${served.product} | ${served.comment}`)
  ok(served.product === order[0], 'served under the fair pick for that post')
  ok(!!served.comment && own.includes(served.comment), "the comment is one of that post's own")

  const { loadVideosJson } = await import('../lib/videos')
  const tt = (await loadVideosJson()).find((v) => /tiktok\.com/.test(v.url))
  if (tt) {
    const s = await serveCommentForUrl(tt.url)
    ok(!!s.comment && !(await storedRedditComments(tt.url, String(s.product))).length,
      'a TikTok link is still served from the bank')
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
