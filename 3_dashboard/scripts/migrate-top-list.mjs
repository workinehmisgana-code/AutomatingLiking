// Add the four top-list columns to the live product_comment_setting table.
//
// ensureAdminTables() would do it on the next admin request, but the columns are
// read by serveCommentForUrl on the WORKER path too, and a missing column there
// is a 500 on a click rather than a slow first admin page.
//   node scripts/migrate-top-list.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

const stmts = [
  `ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS top_enabled BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS top_count INT NOT NULL DEFAULT 20`,
  `ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS top_rank TEXT NOT NULL DEFAULT 'balanced'`,
  `ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS top_days INT NOT NULL DEFAULT 30`,
]
for (const q of stmts) {
  await pool.query(q)
  console.log('ok  ' + q.slice(0, 78))
}

const { rows } = await pool.query(
  `SELECT product, top_enabled, top_count, top_rank, top_days
     FROM product_comment_setting ORDER BY product`
)
console.log('\nrows now:')
for (const r of rows) {
  console.log(
    `  ${r.product.padEnd(18)} top=${r.top_enabled ? 'on ' : 'off'} ` +
      `count=${r.top_count} rank=${r.top_rank} days=${r.top_days}`
  )
}
await pool.end()
