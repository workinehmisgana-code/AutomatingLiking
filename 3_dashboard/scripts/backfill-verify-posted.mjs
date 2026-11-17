// Fill the posted date of staged TikTok links that have none, from the video id
// (its top 32 bits are the upload time — see tiktokPostedDate in lib/linkStats).
//   node --env-file=.env scripts/backfill-verify-posted.mjs          (dry run)
//   node --env-file=.env scripts/backfill-verify-posted.mjs --save
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const DATE_SQL = `to_char(to_timestamp(floor(
    (substring(url from '/(?:video|photo)/([0-9]{15,25})'))::numeric / 4294967296
  )) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
const WHERE = `(posted_date IS NULL OR btrim(posted_date) = '')
  AND url ~ 'tiktok\\.com/.*/(video|photo)/[0-9]{15,25}'`

const { rows } = await pool.query(
  `SELECT coalesce(genre,'humanizer') genre, count(*)::int n, min(${DATE_SQL}) oldest, max(${DATE_SQL}) newest
     FROM verify_link WHERE ${WHERE} GROUP BY 1 ORDER BY 2 DESC`
)
console.log('staged TikTok links with no posted date:', rows)
const sample = await pool.query(`SELECT url, ${DATE_SQL} d FROM verify_link WHERE ${WHERE} LIMIT 3`)
console.log(sample.rows)
if (process.argv.includes('--save')) {
  const r = await pool.query(`UPDATE verify_link SET posted_date = ${DATE_SQL} WHERE ${WHERE}`)
  console.log(`filled ${r.rowCount} row(s)`)
} else {
  console.log('dry run — pass --save')
}
await pool.end()
