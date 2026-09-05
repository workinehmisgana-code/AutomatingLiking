// Read-only: how thorough is "Extract comments", really?
//
// The scan reads at most MAX_PAGES x 50 top-level comments and never fetches
// replies, so "none of ours" is only ever as good as what it managed to read.
// This reports how deep it actually got.
//
//   node scripts/check-scan-depth.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await pool.query(sql, p)).rows

const [t] = await q(`
  SELECT COUNT(*)::int AS scanned,
         COUNT(*) FILTER (WHERE read_count = 0)::int          AS read_nothing,
         COUNT(*) FILTER (WHERE complete)::int                AS marked_complete,
         COUNT(*) FILTER (WHERE complete AND read_count = 0)::int AS complete_but_empty,
         COUNT(*) FILTER (WHERE NOT complete)::int            AS partial,
         COUNT(*) FILTER (WHERE read_count >= 200)::int       AS hit_the_page_cap,
         COUNT(*) FILTER (WHERE total_count > read_count)::int AS more_than_we_read
    FROM link_comment_scan`)

console.log(`scanned links            : ${t.scanned}`)
console.log(`  read zero comments    : ${t.read_nothing}`)
console.log(`  marked complete       : ${t.marked_complete}   (of which ${t.complete_but_empty} read nothing)`)
console.log(`  partial               : ${t.partial}`)
console.log(`  hit the 200 page cap  : ${t.hit_the_page_cap}`)
console.log(`  TikTok claims more than we read : ${t.more_than_we_read}`)

const depth = await q(`
  SELECT CASE
           WHEN read_count = 0 THEN '0'
           WHEN read_count < 10 THEN '1-9'
           WHEN read_count < 50 THEN '10-49'
           WHEN read_count < 200 THEN '50-199'
           ELSE '200 (capped)'
         END AS band,
         COUNT(*)::int AS links,
         ROUND(AVG(COALESCE(total_count, 0))::numeric, 0) AS avg_claimed
    FROM link_comment_scan
   GROUP BY 1 ORDER BY MIN(read_count)`)
console.log('\ncomments actually read per link:')
for (const r of depth) {
  console.log(`   ${r.band.padEnd(13)} ${String(r.links).padStart(5)} link(s)   TikTok claimed ${r.avg_claimed} on average`)
}

// The number the "Ours" column is built from.
const [c] = await q(`
  SELECT COUNT(*) FILTER (WHERE p.url IS NULL AND s.read_count > 0)::int AS read_and_clean,
         COUNT(*) FILTER (WHERE p.url IS NOT NULL)::int                  AS carries_ours
    FROM link_comment_scan s
    LEFT JOIN (SELECT DISTINCT url FROM link_product_comment) p ON p.url = s.url`)
console.log(`\nlinks read with NONE of ours found : ${c.read_and_clean}`)
console.log(`links carrying at least one of ours: ${c.carries_ours}`)
console.log(
  '\nThe first number is the one the "Ours" column cannot currently show:\n' +
    'it has no link_product_comment rows, so it is indistinguishable from\n' +
    '"never extracted" unless the column is told which links were scanned.'
)

await pool.end()
