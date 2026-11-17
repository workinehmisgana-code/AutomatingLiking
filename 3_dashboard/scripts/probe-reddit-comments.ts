// Per-post Reddit comments, live, for a few Reddit posts in the pool. Nothing
// is saved: it reads the post the way lib/redditComments does, sends the same
// prompt and runs the same filter.
//   node scripts/run-ts-check.mjs scripts/probe-reddit-comments.ts [count]
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const { pool, getProductCommentSettings } = await import('../lib/db')
  const { llmChat } = await import('../lib/llm')
  const { readRedditPost, cleanRedditComments, parseRedditComments, REDDIT_COMMENTS_PER_POST } = await import('../lib/redditComments')
  const { productOrderForUrl } = await import('../lib/serveComment')
  const { redditCommentSystem, redditCommentUser } = await import('../lib/prompts')

  const n = Number(process.argv[2]) || 2
  const { rows } = await pool.query<{ url: string }>(
    `SELECT url FROM link_title WHERE url LIKE '%reddit.com/r/%' ORDER BY random() LIMIT $1`, [n])
  if (process.argv[3]) rows.splice(0, rows.length, { url: process.argv[3] })
  const { rows: cnt } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM link_title WHERE url LIKE '%reddit.com/r/%'`)
  console.log(`reddit posts with a saved title: ${cnt[0].n}`)
  for (const { url } of rows) {
    const post = await readRedditPost(url)
    const { order } = await productOrderForUrl(url)
    const product = (order[0] ?? 'purifytext') as never
    const { style } = await getProductCommentSettings(product, { min: 3, max: 30 })
    const t0 = Date.now()
    const r = await llmChat({
      temperature: 1.0, jsonObject: true, maxTokens: 6000,
      messages: [
        { role: 'system', content: redditCommentSystem(product, style, REDDIT_COMMENTS_PER_POST + 2) },
        { role: 'user', content: redditCommentUser(post) },
      ],
    })
    const raw = parseRedditComments(r.content)
    const kept = cleanRedditComments(product, raw, style)
    if (process.argv[3]) console.log('RAW', raw.length, JSON.stringify(raw, null, 1), r.content.slice(-300))
    console.log(`\n${url}\n  r/${post.subreddit} | "${post.title}" | body ${post.body ? post.body.length + ' chars' : 'not readable'}`)
    console.log(`  product ${product} (served order ${order.join(', ') || 'none'}), ${r.model}, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${kept.length} kept`)
    kept.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
