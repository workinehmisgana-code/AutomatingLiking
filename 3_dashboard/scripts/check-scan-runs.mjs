// Exercise the scan-run machinery against the real database, then clean up.
//
// The per-product totals are merged in SQL over JSONB, which is the one piece
// here that cannot be reasoned about from the TypeScript — this runs it.
//
//   node scripts/check-scan-runs.mjs
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
// jsonb does not preserve key order, so compare by content rather than by the
// string a stringify happens to produce.
const norm = (v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))))
    : JSON.stringify(v)
const check = (name, got, want) => {
  const ok = norm(got) === norm(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

// The schema has to exist before anything else can be checked.
const tables = await q(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('link_scan_run','link_scan_event')
    ORDER BY table_name`
)
console.log('schema:')
check('both tables exist', tables.map((t) => t.table_name), ['link_scan_event', 'link_scan_run'])
if (tables.length < 2) {
  console.log('\n(the tables are created lazily by ensureClickedTable — start the app once)')
  await pool.end()
  process.exit(1)
}

const SCOPE = '__test__scope'
await q('DELETE FROM link_scan_event WHERE run_id IN (SELECT id FROM link_scan_run WHERE scope_key = $1)', [SCOPE])
await q('DELETE FROM link_scan_run WHERE scope_key = $1', [SCOPE])

const [{ id }] = await q(
  'INSERT INTO link_scan_run (scope_key, scope_label) VALUES ($1, $2) RETURNING id',
  [SCOPE, 'test scope']
)

// The exact merge statement from recordScanRunBatch, run twice.
const fold = async (links, read, ours, withOurs, perProduct) =>
  q(
    `UPDATE link_scan_run
        SET links = links + $2, comments_read = comments_read + $3, ours = ours + $4,
            links_with_ours = links_with_ours + $5,
            per_product = COALESCE((
              SELECT jsonb_object_agg(k, v) FROM (
                SELECT k, SUM(v)::int AS v FROM (
                  SELECT key AS k, value::int AS v FROM jsonb_each_text(per_product)
                  UNION ALL
                  SELECT key, value::int FROM jsonb_each_text($6::jsonb)
                ) parts GROUP BY k
              ) merged
            ), '{}'::jsonb),
            updated_at = now()
      WHERE id = $1`,
    [id, links, read, ours, withOurs, JSON.stringify(perProduct)]
  )

console.log('\nfolding batches into a run:')
await fold(2, 30, 3, 2, { purifytext: 2, humlexic: 1 })
let [r] = await q('SELECT * FROM link_scan_run WHERE id = $1', [id])
check('after batch 1 — totals', [r.links, r.comments_read, r.ours, r.links_with_ours], [2, 30, 3, 2])
check('after batch 1 — per product', r.per_product, { purifytext: 2, humlexic: 1 })

await fold(3, 45, 4, 3, { purifytext: 1, acoustictext: 3 })
;[r] = await q('SELECT * FROM link_scan_run WHERE id = $1', [id])
check('after batch 2 — totals', [r.links, r.comments_read, r.ours, r.links_with_ours], [5, 75, 7, 5])
check('after batch 2 — products ADDED, not replaced', r.per_product, {
  purifytext: 3,
  humlexic: 1,
  acoustictext: 3,
})

// An empty batch must not wipe the map — jsonb_object_agg over nothing is NULL.
await fold(0, 0, 0, 0, {})
;[r] = await q('SELECT * FROM link_scan_run WHERE id = $1', [id])
check('an empty batch leaves the products alone', r.per_product, {
  purifytext: 3,
  humlexic: 1,
  acoustictext: 3,
})

console.log('\nthe per-run ledger:')
await q(
  `INSERT INTO link_scan_event (run_id, url)
   SELECT $1, u FROM unnest($2::text[]) AS u ON CONFLICT (run_id, url) DO NOTHING`,
  [id, ['https://a', 'https://b']]
)
await q(
  `INSERT INTO link_scan_event (run_id, url)
   SELECT $1, u FROM unnest($2::text[]) AS u ON CONFLICT (run_id, url) DO NOTHING`,
  [id, ['https://b', 'https://c']]
)
const ev = await q('SELECT url FROM link_scan_event WHERE run_id = $1 ORDER BY url', [id])
check('re-inserting a url does not duplicate it', ev.map((e) => e.url), ['https://a', 'https://b', 'https://c'])

// A second run over the same scope must NOT inherit the first run's ledger —
// that is what makes every press a fresh read.
const [{ id: id2 }] = await q(
  'INSERT INTO link_scan_run (scope_key, scope_label) VALUES ($1, $2) RETURNING id',
  [SCOPE, 'test scope']
)
const ev2 = await q('SELECT url FROM link_scan_event WHERE run_id = $1', [id2])
check('a new run starts with an empty ledger', ev2.length, 0)

const grouped = await q(
  'SELECT scope_key, COUNT(*)::int AS runs FROM link_scan_run WHERE scope_key = $1 GROUP BY scope_key',
  [SCOPE]
)
check('both runs group under one scope', grouped[0].runs, 2)

await q('DELETE FROM link_scan_event WHERE run_id IN (SELECT id FROM link_scan_run WHERE scope_key = $1)', [SCOPE])
await q('DELETE FROM link_scan_run WHERE scope_key = $1', [SCOPE])
console.log('\ntest rows removed.')

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
await pool.end()
process.exit(fails === 0 ? 0 : 1)
