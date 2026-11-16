// The harvest stage of every recent pipeline cycle: which platforms were on,
// how many channels were eligible, what it found and merged.
//   node --env-file=.env scripts/probe-harvest-history.mjs
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const { rows } = await pool.query(`SELECT id, started_at, stages->'harvest' h FROM pipeline_cycle ORDER BY id DESC LIMIT 60`)
for (const r of rows) {
  const h = r.h || {}
  console.log(
    `${r.id} ${new Date(r.started_at).toISOString().slice(0, 16)} on=${JSON.stringify(h.platforms ?? null)} ` +
      `eligible=${h.eligible ?? '-'} checked=${h.checked ?? '-'} found=${h.found ?? '-'} merged=${h.merged ?? '-'} ` +
      `staged=${h.staged ?? '-'} specMerged=${h.specMerged ?? '-'}`
  )
}
const sw = await pool.query(`SELECT key, left(value::text, 200) v FROM app_kv WHERE key ILIKE '%platform%'`)
console.log(sw.rows)
await pool.end()
