// Read-only (bar a scratch KV row it removes): is the hourly harvest wired up?
//
// Checks the two things that cannot be seen from the TypeScript: the app_kv
// table the cursor lives in, and how many channels actually clear the score
// threshold — which decides whether this job has anything to do at all.
//
//   node scripts/check-harvest.mjs
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

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`)
}

console.log('the cursor store:')
const [t] = await q(
  `SELECT COUNT(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_kv'`
)
check('app_kv exists', t.n === 1)
if (t.n === 1) {
  await q('DELETE FROM app_kv WHERE key = $1', ['__test__'])
  await q(
    `INSERT INTO app_kv (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    ['__test__', '7']
  )
  const [a] = await q('SELECT value FROM app_kv WHERE key = $1', ['__test__'])
  check('a value can be written and read', a?.value === '7', `(${a?.value})`)
  await q(
    `INSERT INTO app_kv (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    ['__test__', '12']
  )
  const [b] = await q('SELECT value FROM app_kv WHERE key = $1', ['__test__'])
  check('writing again updates rather than duplicating', b?.value === '12', `(${b?.value})`)
  await q('DELETE FROM app_kv WHERE key = $1', ['__test__'])

  const cur = await q('SELECT key, value, updated_at FROM app_kv ORDER BY key')
  console.log(`\n   ${cur.length} live key(s):`)
  for (const r of cur) {
    const v = r.value.length > 90 ? r.value.slice(0, 90) + '…' : r.value
    console.log(`      ${r.key} = ${v}`)
  }
}

// How many channels clear the bar? The score is four percentiles blended, so
// "0.5" is roughly the top half — but only roughly, and it is worth seeing.
console.log('\nchannels the harvest would watch:')
const chans = await q(`
  SELECT lower(substring(url from 'tiktok\\.com/@([A-Za-z0-9._]+)/')) AS handle,
         COUNT(*)::int AS links
    FROM clicked_link
   WHERE url ILIKE '%tiktok.com/@%'
   GROUP BY 1 HAVING lower(substring(url from 'tiktok\\.com/@([A-Za-z0-9._]+)/')) IS NOT NULL`)
console.log(`   ${chans.length} channel(s) appear in the click history`)
console.log('   (the real list comes from rankChannels over videos.json — run the')
console.log('    harvest once and its summary reports how many cleared 0.5)')

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
await pool.end()
process.exit(fails === 0 ? 0 : 1)
