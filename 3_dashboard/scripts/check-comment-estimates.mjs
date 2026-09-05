// Read-only: what does "Extract comments" actually know about the pool?
//
// The link feed orders on the extraction result — links with none of our
// products in their comments go out first, then the ones where our products are
// thin against everything else on the video. That only works if the extraction
// has covered enough links, and if unscanned links are NOT quietly counted as
// empty. This reports both.
//
//   node scripts/check-comment-estimates.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

// dotenv is not a dependency here, and .env is a few KEY=VALUE lines: parsing it
// is cheaper than adding a package for one script.
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of envText.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const q = async (sql, params = []) => (await pool.query(sql, params)).rows

const [totals] = await q(
  `SELECT COUNT(*)::int                                      AS scanned,
          COUNT(*) FILTER (WHERE our_count = 0)::int         AS none_of_ours,
          COUNT(*) FILTER (WHERE our_count > 0)::int         AS has_ours,
          COALESCE(SUM(read_count), 0)::int                  AS comments_read,
          COALESCE(SUM(our_count), 0)::int                   AS ours_found
     FROM link_comment_scan`
)

const [clicked] = await q(
  `SELECT COUNT(DISTINCT cl.url)::int AS clicked,
          COUNT(DISTINCT cl.url) FILTER (WHERE s.url IS NULL)::int AS clicked_unscanned
     FROM clicked_link cl
     LEFT JOIN link_comment_scan s ON s.url = cl.url`
)

// How thin our comments are against everything else on the video. This is the
// "fewer than the rest" ordering key.
const share = await q(
  `SELECT width_bucket(our_count::numeric / GREATEST(read_count, 1), 0, 0.5, 5) AS bucket,
          COUNT(*)::int AS links,
          ROUND(AVG(our_count)::numeric, 1) AS avg_ours,
          ROUND(AVG(read_count)::numeric, 0) AS avg_read
     FROM link_comment_scan
    WHERE our_count > 0 AND read_count > 0
    GROUP BY 1 ORDER BY 1`
)

// Does the scan read enough of a video to trust "none of ours"? A scan that read
// 20 of 400 comments and found none of ours has not shown much.
const depth = await q(
  `SELECT complete,
          COUNT(*)::int AS links,
          ROUND(AVG(read_count)::numeric, 0) AS avg_read,
          ROUND(AVG(COALESCE(total_count, 0))::numeric, 0) AS avg_total
     FROM link_comment_scan
    GROUP BY complete ORDER BY complete DESC`
)

console.log(`scanned links           : ${totals.scanned}`)
console.log(`  none of our products  : ${totals.none_of_ours}   <- delivered first`)
console.log(`  carrying our products : ${totals.has_ours}`)
console.log(`  comments read overall : ${totals.comments_read}, ours among them ${totals.ours_found}`)
console.log()
console.log(`links ever clicked      : ${clicked.clicked}`)
console.log(`  of those, unscanned   : ${clicked.clicked_unscanned}  <- no evidence either way`)
console.log()
console.log('how thin our comments are, where we appear at all:')
for (const r of share) {
  const lo = ((r.bucket - 1) * 10).toFixed(0)
  const hi = r.bucket > 5 ? '50+' : (r.bucket * 10).toFixed(0)
  console.log(
    `   ${String(lo).padStart(3)}-${String(hi).padEnd(3)}% of comments are ours : ` +
      `${String(r.links).padStart(5)} links  (avg ${r.avg_ours} of ${r.avg_read} read)`
  )
}
console.log()
console.log('scan depth - can "none of ours" be trusted?')
for (const r of depth) {
  console.log(
    `   complete=${r.complete}: ${String(r.links).padStart(5)} links, ` +
      `read ${r.avg_read} of ${r.avg_total} comments on average`
  )
}

await pool.end()
