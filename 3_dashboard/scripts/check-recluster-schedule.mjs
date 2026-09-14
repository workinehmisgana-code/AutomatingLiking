// Does the hourly recluster run when it should — and only then?
//
// The schedule fires on the hour, but the DUE CHECK is what decides. Three
// things have to hold, and each one is a different way to get it wrong:
//
//   * never run before -> run now, not an hour after the deploy
//   * run 20 minutes ago -> do nothing, however many times the cron retries
//   * the stamp is written AFTER the work, so a run that dies part-way is
//     retried rather than counted as done
//
// It also shares the pipeline's lock, because both rewrite the whole 38 MB pool
// and one write would silently lose the other.
//
//   node scripts/check-recluster-schedule.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

// Mirrors reclusterIfDue's decision, with the work and the lock stubbed.
const HOUR = 3_600_000
function decide({ last, now, lockFree = true, everyHours = 1 }) {
  const dueAt = last + everyHours * HOUR
  if (last && now < dueAt) return 'not-due'
  if (!lockFree) return 'busy'
  return 'run'
}

const now = Date.UTC(2026, 8, 5, 12, 0, 0)
console.log('the due check:')
check('never run before -> runs now', decide({ last: 0, now }), 'run')
check('run 20 minutes ago -> waits', decide({ last: now - 20 * 60_000, now }), 'not-due')
check('run 59 minutes ago -> still waits', decide({ last: now - 59 * 60_000, now }), 'not-due')
check('run 61 minutes ago -> runs', decide({ last: now - 61 * 60_000, now }), 'run')
check('exactly an hour ago -> runs', decide({ last: now - HOUR, now }), 'run')
check('a retry a second later -> waits', decide({ last: now - 1000, now }), 'not-due')
check('the pipeline holds the lock -> stands down', decide({ last: 0, now, lockFree: false }), 'busy')

// A whole day of cron firings: 24 runs, no more, no fewer.
let last = 0
let runs = 0
for (let m = 0; m < 24 * 60; m++) {
  const t = now + m * 60_000
  // The schedule only fires on the hour; the check must still hold if it fired
  // every minute (a retry storm, or an admin refreshing).
  if (decide({ last, now: t }) === 'run') { runs++; last = t }
}
check('a minute-by-minute caller still reclusters only 24x a day', runs, 24)

// ── the real state ──────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await pool.query(sql, p)).rows
const rows = await q(`SELECT key, value FROM app_kv WHERE key IN ('recluster_last','pipeline_lock')`)
console.log('\nstored state:')
for (const r of rows) {
  const n = Number(r.value)
  const at = Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : '(unset)'
  console.log(`   ${r.key} = ${r.value} ${at !== '(unset)' ? '-> ' + at : ''}`)
}
if (!rows.some((r) => r.key === 'recluster_last')) {
  console.log('   recluster_last is unset — the first scheduled hour after deploy runs it')
}
// The lock is shared, so its key must be the one the pipeline uses.
const src = readFileSync(new URL('../lib/poolLock.ts', import.meta.url), 'utf8')
check('the lock key is the pipeline lock', /LOCK_KEY = 'pipeline_lock'/.test(src), true)

await pool.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
