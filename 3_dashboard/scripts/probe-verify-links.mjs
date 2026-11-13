// What is in the "Links to verify" staging list, by genre and platform, and
// when rows were last added / removed.
//   node --env-file=.env scripts/probe-verify-links.mjs
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const q = async (sql, p = []) => (await pool.query(sql, p)).rows

console.log('total:', await q(`SELECT count(*)::int n, max(added_at) last_added, min(added_at) first_added FROM verify_link`))
console.log('by genre/platform:', await q(
  `SELECT coalesce(genre,'(null)') genre, platform, count(*)::int n FROM verify_link GROUP BY 1,2 ORDER BY 3 DESC`))
const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'verify_link'`)
console.log('columns:', cols.map((c) => c.column_name).join(', '))
const kv = await q(`SELECT key, left(value::text, 200) v FROM app_kv WHERE key ILIKE '%verify%' OR key ILIKE '%admin_genre%'`).catch((e) => String(e))
console.log('app_kv verify keys:', kv)
await pool.end()
