// Read-only: does the freshness cutoff actually exclude stale verdicts?
//
// "Check comment presence" re-reads a link unless THIS pass already judged it.
// That rests on one comparison — checked_at against the pass's start — so this
// exercises it against the real ledger rather than trusting it.
//
//   node scripts/check-presence-freshness.mjs
import { readFileSync } from 'node:fs'
import pg from 'pg'

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of envText.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, params = []) => (await pool.query(sql, params)).rows

// The exact query lib/db.ts runs, both ways.
const judged = (userId, day, since) =>
  since
    ? q(
        `SELECT url FROM comment_presence_link
          WHERE user_id = $1 AND day = $2::date AND checked_at >= $3::timestamptz`,
        [userId, day, since]
      )
    : q('SELECT url FROM comment_presence_link WHERE user_id = $1 AND day = $2::date', [
        userId,
        day,
      ])

const [{ now }] = await q('SELECT now() AS now')
const nowIso = now.toISOString()

// A user/day with a decent number of judged links.
const [pick] = await q(
  `SELECT user_id, day::text AS day, COUNT(*)::int AS n,
          MIN(checked_at) AS oldest, MAX(checked_at) AS newest
     FROM comment_presence_link
    GROUP BY user_id, day
    ORDER BY COUNT(*) DESC
    LIMIT 1`
)
if (!pick) {
  console.log('The ledger is empty — nothing to check.')
  await pool.end()
  process.exit(0)
}

const all = await judged(pick.user_id, pick.day)
const asOfNow = await judged(pick.user_id, pick.day, nowIso)
const anHourAgo = new Date(Date.parse(nowIso) - 3_600_000).toISOString()
const recent = await judged(pick.user_id, pick.day, anHourAgo)
const longAgo = new Date(Date.parse(nowIso) - 3650 * 86_400_000).toISOString()
const everything = await judged(pick.user_id, pick.day, longAgo)

console.log(`sample: user ${pick.user_id.slice(0, 8)}… on ${pick.day}, ${pick.n} judged link(s)`)
console.log(`  oldest verdict ${pick.oldest.toISOString()}`)
console.log(`  newest verdict ${pick.newest.toISOString()}`)
console.log(`  database now   ${nowIso}`)
console.log()
console.log(`no cutoff (old behaviour)   : ${all.length} treated as done`)
console.log(`cutoff = now (a new pass)   : ${asOfNow.length} treated as done  <- must be 0`)
console.log(`cutoff = 1 hour ago         : ${recent.length} treated as done`)
console.log(`cutoff = 10 years ago       : ${everything.length} treated as done`)
console.log()

const ok = asOfNow.length === 0 && everything.length === all.length && all.length > 0
console.log(
  ok
    ? 'ok — a new pass re-reads every link, and a wide cutoff reuses every link.'
    : 'FAILED — the cutoff is not filtering the way the code assumes.'
)

// How much a nightly window would re-read, at the cron's default.
const [cron] = await q(
  `SELECT COUNT(*) FILTER (WHERE checked_at < now() - interval '6 hours')::int AS stale,
          COUNT(*)::int AS total
     FROM comment_presence_link`
)
console.log()
console.log(
  `across the whole ledger: ${cron.stale} of ${cron.total} verdicts are older than the ` +
    `cron's 6-hour window, so the next run re-reads those links`
)

await pool.end()
process.exit(ok ? 0 : 1)
