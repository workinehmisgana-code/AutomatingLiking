// Re-arm the automatic check for people who were unblocked before the rule changed.
//
// auto_block_exempt used to fill itself: every unblock added a row, and that row
// put the person outside the automatic rule permanently. unblockUser now removes
// a row instead of adding one, so nothing new lands here — but the rows written
// under the old behaviour are still there, and the people in them are still
// immune. This clears them.
//
// WHAT IT MEANS FOR THEM. Each one becomes judgeable again by the nightly sweep
// and by the verify button. Anyone whose comment still cannot be found on 50 of
// their recent links will be blocked, most likely by tonight's cron. That is the
// point of the change, but it is not a small thing — these are workers with
// hundreds of confirmed comments, which is why they were unblocked in the first
// place — so this prints who and what, and writes nothing without --apply.
//
//   node scripts/clear-auto-block-exempt.mjs           who would be re-armed
//   node scripts/clear-auto-block-exempt.mjs --apply
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const apply = process.argv.includes('--apply')

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

// For each exempt user: their history, and — the number that decides their fate —
// how many of their most recent judged links carry a comment. This mirrors
// noCommentVerdict on stored verdicts only, so it is a preview and not a promise:
// the real run re-reads the links.
const { rows } = await db.query(
  `WITH r AS (
     SELECT c.user_id, c.url, c.clicked_at::date AS day, c.clicked_at,
            row_number() OVER (PARTITION BY c.user_id ORDER BY c.clicked_at DESC) AS rn
       FROM clicked_link c
      WHERE c.url ILIKE '%tiktok.com%'
        AND c.user_id IN (SELECT user_id FROM auto_block_exempt)
   )
   SELECT e.user_id, e.exempted_at, p.name, p.tiktok_url,
          (SELECT count(*)::int FROM comment_presence_link l
            WHERE l.user_id = e.user_id AND l.found) AS found_ever,
          (SELECT max(l.day) FROM comment_presence_link l
            WHERE l.user_id = e.user_id AND l.found) AS last_found,
          (SELECT count(*)::int FROM r JOIN comment_presence_link l
                 ON l.user_id = r.user_id AND l.url = r.url AND l.day = r.day
            WHERE r.user_id = e.user_id AND r.rn <= 300 AND l.judgeable) AS judged_recent,
          (SELECT count(*)::int FROM r JOIN comment_presence_link l
                 ON l.user_id = r.user_id AND l.url = r.url AND l.day = r.day
            WHERE r.user_id = e.user_id AND r.rn <= 300 AND l.found) AS found_recent,
          -- The rate rule's own numbers: the newest 200 JUDGED links, which is a
          -- different set from "judged among the newest 300".
          (SELECT count(*)::int FROM (
             SELECT l.found, row_number() OVER (ORDER BY r2.clicked_at DESC) jn
               FROM r r2 JOIN comment_presence_link l
                 ON l.user_id = r2.user_id AND l.url = r2.url AND l.day = r2.day
              WHERE r2.user_id = e.user_id AND r2.rn <= 500 AND l.judgeable
           ) z WHERE z.jn <= 200) AS rate_judged,
          (SELECT count(*) FILTER (WHERE z.found)::int FROM (
             SELECT l.found, row_number() OVER (ORDER BY r2.clicked_at DESC) jn
               FROM r r2 JOIN comment_presence_link l
                 ON l.user_id = r2.user_id AND l.url = r2.url AND l.day = r2.day
              WHERE r2.user_id = e.user_id AND r2.rn <= 500 AND l.judgeable
           ) z WHERE z.jn <= 200) AS rate_found
     FROM auto_block_exempt e
     LEFT JOIN user_profile p ON p.user_id = e.user_id
    ORDER BY e.exempted_at`
)

/** Which rule would act on them, on stored verdicts alone. */
function verdict(r) {
  if (r.found_recent === 0 && r.judged_recent >= 50) return 'nothing on 50 judged links'
  const pct = r.rate_judged > 0 ? Math.round((100 * r.rate_found) / r.rate_judged) : null
  if (r.rate_judged >= 200 && pct !== null && pct < 10) {
    return `${pct}% of their last ${r.rate_judged} judged links`
  }
  return ''
}

if (rows.length === 0) {
  console.log('auto_block_exempt is empty — nothing to re-arm.')
  await db.end()
  process.exit(0)
}

console.log(`${rows.length} user(s) are currently immune to the automatic check:\n`)
let atRisk = 0
for (const r of rows) {
  const why = verdict(r)
  const risky = !!why
  if (risky) atRisk++
  console.log(
    `  ${risky ? '!' : ' '} ${(r.name ?? '(no name)').padEnd(20)} exempt since ` +
      `${String(r.exempted_at).slice(0, 10)}`
  )
  console.log(
    `      ${r.found_ever} comment(s) found all time, last on ` +
      `${r.last_found ? String(r.last_found).slice(0, 10) : 'never'}`
  )
  console.log(
    `      of their last 300 links, ${r.found_recent} found of ${r.judged_recent} judged` +
      `${r.rate_judged ? `; rate rule sees ${r.rate_found} of ${r.rate_judged}` : ''}`
  )
  if (risky) console.log(`      <- WOULD BE BLOCKED: ${why}`)
}
console.log(
  `\n${atRisk} of them would be blocked on the next check, on verdicts already stored — ` +
    'by either rule.'
)
console.log(
  'A fresh check reads their links again, so the real answer can differ; and a user with ' +
    'under 200 judged\nlinks is outside the rate rule until more of them are read.'
)

if (!apply) {
  console.log('Nothing was written. Add --apply to clear the list.')
  await db.end()
  process.exit(0)
}

const res = await db.query('DELETE FROM auto_block_exempt')
console.log(`\nCleared ${res.rowCount} row(s). The automatic check now judges all of them.`)
await db.end()
