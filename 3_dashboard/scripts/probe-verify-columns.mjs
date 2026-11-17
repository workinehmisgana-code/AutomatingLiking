// Why are Posted / Active % empty on the verify page? How many staged rows
// have a posted date, per genre and by when they were added.
//   node --env-file=.env scripts/probe-verify-columns.mjs
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const q = async (sql, p = []) => (await pool.query(sql, p)).rows
console.log(await q(`
  SELECT coalesce(genre,'(null)') genre, count(*)::int n,
         count(*) FILTER (WHERE posted_date IS NOT NULL AND btrim(posted_date) <> '')::int with_posted,
         count(*) FILTER (WHERE btrim(coalesce(title,'')) <> '')::int with_title,
         count(*) FILTER (WHERE view_count > 0)::int with_views,
         count(*) FILTER (WHERE account IS NOT NULL AND account <> '')::int with_account,
         min(added_at) first, max(added_at) last
    FROM verify_link GROUP BY 1 ORDER BY 2 DESC`))
console.log(await q(`SELECT url, account, platform, posted_date, view_count, left(title, 40) t, added_at
                       FROM verify_link ORDER BY added_at DESC LIMIT 5`))
await pool.end()
