// Does a cycle's report add up across ticks?
//
// A stage takes many ticks. If each tick REPLACED the stage's numbers the report
// would show the last 45-second slice as though it were the whole stage — which
// is the sort of wrong that looks perfectly reasonable. Counts have to add.
//
//   node scripts/check-pipeline-report.mjs
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

const [t] = await q(
  `SELECT COUNT(*)::int AS n FROM information_schema.tables
    WHERE table_schema='public' AND table_name='pipeline_cycle'`
)
console.log('schema:')
check('pipeline_cycle exists', t.n === 1)
if (t.n !== 1) {
  console.log('\n(run: node scripts/apply-schema.mjs)')
  await pool.end()
  process.exit(1)
}

// Mirrors recordPipelineStage.
async function record(id, stage, summary, addCounts = []) {
  const [{ stages }] = await q('SELECT stages FROM pipeline_cycle WHERE id = $1', [id])
  const cur = stages ?? {}
  const prev = cur[stage] ?? {}
  const next = { ...prev, ...summary }
  for (const k of addCounts) {
    const a = Number(prev[k])
    const b = Number(summary[k])
    if (Number.isFinite(b)) next[k] = (Number.isFinite(a) ? a : 0) + b
  }
  next.ticks = (Number(prev.ticks) || 0) + 1
  cur[stage] = next
  await q('UPDATE pipeline_cycle SET stages = $2::jsonb WHERE id = $1', [id, JSON.stringify(cur)])
}

const [{ id }] = await q('INSERT INTO pipeline_cycle DEFAULT VALUES RETURNING id')
console.log('\nthree extract ticks of 40, 40 and 25 links:')
await record(id, 'extract', { read: 40, withOurs: 3, progress: '40/105' }, ['read', 'withOurs'])
await record(id, 'extract', { read: 40, withOurs: 5, progress: '80/105' }, ['read', 'withOurs'])
await record(id, 'extract', { read: 25, withOurs: 2, progress: '105/105' }, ['read', 'withOurs'])

let [{ stages }] = await q('SELECT stages FROM pipeline_cycle WHERE id = $1', [id])
check('links read ADD up', stages.extract.read === 105, `(${stages.extract.read})`)
check('ours found add up', stages.extract.withOurs === 10, `(${stages.extract.withOurs})`)
check('ticks counted', stages.extract.ticks === 3, `(${stages.extract.ticks})`)
check('non-count fields take the newest', stages.extract.progress === '105/105', `(${stages.extract.progress})`)

console.log('\na second stage does not disturb the first:')
await record(id, 'categorise', { processed: 60, remaining: 0, done: true }, ['processed'])
;[{ stages }] = await q('SELECT stages FROM pipeline_cycle WHERE id = $1', [id])
check('extract untouched', stages.extract.read === 105)
check('categorise recorded', stages.categorise.processed === 60)
check('both stages present', Object.keys(stages).sort().join() === 'categorise,extract')

console.log('\nclosing the cycle:')
await q('UPDATE pipeline_cycle SET finished_at = now() WHERE id = $1', [id])
const [row] = await q('SELECT started_at, finished_at FROM pipeline_cycle WHERE id = $1', [id])
check('finished_at set', !!row.finished_at)
check('finished at or after it started', new Date(row.finished_at) >= new Date(row.started_at))

await q('DELETE FROM pipeline_cycle WHERE id = $1', [id])
console.log('\ntest row removed.')

const real = await q(
  'SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE finished_at IS NULL)::int AS running FROM pipeline_cycle'
)
console.log(`\n${real[0].n} real cycle(s) recorded so far, ${real[0].running} still running`)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
await pool.end()
process.exit(fails === 0 ? 0 : 1)
