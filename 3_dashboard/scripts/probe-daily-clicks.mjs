// Clicks per day, by product and by user, for the last 10 days.
//   node scripts/probe-daily-clicks.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')])
)
const db = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await db.connect()
const q = async (sql, p = []) => (await db.query(sql, p)).rows

console.log('per day, per product (UTC days):')
console.table(await q(`
  SELECT clicked_at::date::text AS day, COALESCE(NULLIF(product,''),'(none)') AS product,
         COUNT(*)::int AS clicks, COUNT(DISTINCT user_id)::int AS users
    FROM clicked_link WHERE clicked_at > now() - interval '10 days'
   GROUP BY 1,2 ORDER BY 1,2`))

console.log('per day, per user, last 4 days:')
console.table(await q(`
  SELECT clicked_at::date::text AS day, user_id, COUNT(*)::int AS clicks,
         MIN(clicked_at)::text AS first, MAX(clicked_at)::text AS last
    FROM clicked_link WHERE clicked_at > now() - interval '4 days'
   GROUP BY 1,2 ORDER BY 1,3 DESC`))

console.log('latest click overall:', (await q(`SELECT MAX(clicked_at)::text AS t FROM clicked_link`))[0])
await db.end()
