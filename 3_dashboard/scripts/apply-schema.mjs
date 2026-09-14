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

// Both lazy-DDL functions, not just the first. product_comment_setting lives in
// ensureAdminTables, so a run that only executed ensureClickedTable reported a
// clean schema while a column added there did not exist — which is exactly the
// failure this script is for.
function ddlOf(fnName, mustContain) {
  const start = src.indexOf(fnName)
  if (start < 0) throw new Error(`${fnName} not found`)
  const open = src.indexOf('`', start)
  const close = src.indexOf('`', open + 1)
  const block = src.slice(open + 1, close)
  if (!block.includes(mustContain)) {
    throw new Error(`the block extracted for ${fnName} is not the schema — lib/db.ts has moved`)
  }
  return block
}

const blocks = [
  ['ensureClickedTable', ddlOf('export function ensureClickedTable', 'link_scan_run')],
  // 'export function', not the bare name: the first bare match is a CALL SITE
  // 2,400 lines earlier, and the backtick after it belongs to someone else's
  // query entirely.
  ['ensureAdminTables', ddlOf('export function ensureAdminTables', 'product_comment_setting')],
]

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
try {
  for (const [name, ddl] of blocks) {
    await pool.query(ddl)
    console.log(`${name}: ${ddl.split('CREATE TABLE').length - 1} table statement(s) parsed and run`)
  }
  console.log('schema applied')
} catch (e) {
  console.error('SCHEMA FAILED — the app would throw for every caller of that block:')
  console.error('  ' + String(e.message || e))
  await pool.end()
  process.exit(1)
}
await pool.end()
