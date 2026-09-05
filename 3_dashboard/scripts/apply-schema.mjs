// Run the app's own schema statement, exactly as lib/db.ts has it.
//
// ensureClickedTable() sends ONE query containing every CREATE TABLE and ALTER
// on that path, so a syntax error anywhere in it takes out every feature that
// touches the database — not just the new table. This extracts that literal from
// the source and executes it, which both creates the tables and proves the SQL
// parses.
//
//   node scripts/apply-schema.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const src = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8')

// The template literal passed to pool.query inside ensureClickedTable.
const start = src.indexOf('export function ensureClickedTable')
if (start < 0) throw new Error('ensureClickedTable not found')
const open = src.indexOf('`', start)
const close = src.indexOf('`', open + 1)
const ddl = src.slice(open + 1, close)
if (!ddl.includes('link_scan_run')) {
  throw new Error('the extracted block is not the schema — lib/db.ts has moved')
}

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
try {
  await pool.query(ddl)
  console.log(`schema applied — ${ddl.split('CREATE TABLE').length - 1} table statement(s) parsed and run`)
} catch (e) {
  console.error('SCHEMA FAILED — ensureClickedTable would throw for every caller:')
  console.error('  ' + String(e.message || e))
  await pool.end()
  process.exit(1)
}
await pool.end()
