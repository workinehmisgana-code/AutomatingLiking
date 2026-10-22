// Why cocodly (website genre) clicks fell from hundreds on 10-17 to a handful.
//   node scripts/probe-cocodly-serving.mjs
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

console.log('settings:')
console.table(await q(`SELECT key, left(value, 200) AS value FROM app_kv
  WHERE key ILIKE '%genre%' OR key ILIKE '%cocodly%' OR key ILIKE '%active%' OR key ILIKE '%mix%' ORDER BY key`))
console.log('active products:', (await q(`SELECT active_comment_products AS v FROM app_state WHERE id = 1`))[0])

console.log('cocodly + (none) clicks per hour, 10-17 .. now:')
console.table(await q(`
  SELECT date_trunc('hour', clicked_at)::text AS hour,
         COUNT(*) FILTER (WHERE product = 'cocodly')::int AS cocodly,
         COUNT(*) FILTER (WHERE COALESCE(product,'') = '')::int AS none,
         COUNT(*)::int AS all_clicks
    FROM clicked_link WHERE clicked_at >= '2026-10-17'
   GROUP BY 1 HAVING COUNT(*) FILTER (WHERE product = 'cocodly' OR COALESCE(product,'') = '') > 0
   ORDER BY 1`))

console.log('distinct cocodly urls ever clicked:',
  (await q(`SELECT COUNT(DISTINCT url)::int AS n FROM clicked_link WHERE product='cocodly'`))[0])
console.log('cocodly clicks on 10-18/19:')
console.table(await q(`SELECT clicked_at::text, user_id, url FROM clicked_link
  WHERE product='cocodly' AND clicked_at >= '2026-10-18' ORDER BY clicked_at`))

const cols = await q(`SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND (table_name ILIKE '%comment%' OR table_name ILIKE '%genre%') ORDER BY 1`)
console.log('tables:', cols.map((r) => r.table_name).join(', '))
await db.end()
