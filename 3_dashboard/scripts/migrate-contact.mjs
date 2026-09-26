// Add the contact columns, exactly as ensureUserProfileTable() does.
//
// The app adds them itself on first use, so this is only for running the change
// before a deploy rather than during one — and for saying how many existing
// users will meet the gate, which is the number worth knowing before turning it
// on.
//
//   node scripts/migrate-contact.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

await db.query(`
  ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS phone    TEXT;
  ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS telegram TEXT;
`)

const cols = await db.query(
  `SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'user_profile' AND column_name IN ('phone','telegram')
    ORDER BY column_name`
)
console.log('columns:', cols.rows.map((r) => `${r.column_name} ${r.data_type}`).join(', '))

const n = await db.query(
  `SELECT count(*)::int AS registered,
          count(*) FILTER (WHERE COALESCE(phone,'') <> ''
                              OR COALESCE(telegram,'') <> '')::int AS reachable
     FROM user_profile`
)
const { registered, reachable } = n.rows[0]
console.log(`${registered} registered user(s), ${reachable} with a phone or Telegram.`)
console.log(`${registered - reachable} will see the gate on their next visit and be asked once.`)
await db.end()
