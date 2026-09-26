// Does the admin's per-user "verify" button check the last 100 links?
//
// The button has read three different populations. The first was the sample links
// the user chose to submit — they picked them, so it proved nothing. The second
// was every link they opened on their last active day, which is honest but not
// comparable: a day is whatever length it happens to be, so one user was judged
// on eleven links and another on 1,373, and the same user's number meant
// something different on Monday than on Tuesday.
//
// It now reads their last 100 links, across however many days those span. Same
// size for everybody, same question, and it is the population the auto-block rule
// already samples from.
//
// THE BULK SWEEP IS STILL PER DAY, deliberately: it fills in a per-day score
// history, which is a different thing from spot-checking a person. This asserts
// both — that the button moved and that the sweep did not.
//
//   node scripts/check-verify-user.mjs
import { readFileSync } from 'node:fs'

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
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const route = read('app/api/admin/verify-user/route.ts')
const sweep = read('app/api/admin/comment-presence/route.ts')
const presence = read('lib/commentPresence.ts')
const db = read('lib/db.ts')
const ui = read('components/AdminDashboard.tsx')

console.log('the button reads the last 100 links:')
check('  the size is named once', /export const RECENT_SAMPLE = 100/.test(presence), true)
check('  and the route uses that name', /RECENT_SAMPLE,/.test(route), true)
check('  through the recent-links scorer', /scoreUserRecent\(/.test(route), true)
check('  not one day of them', /scoreUserDay/.test(route), false)
check('  nor the last active day', /getLastActiveDay/.test(route), false)
check('  the population spans days', /getRecentClickedLinks\(userId, limit\)/.test(presence), true)
check('  newest first', /newest first/.test(presence), true)
check('  and why a day was the wrong population', /1,373/.test(presence), true)

console.log('\nwithout redefining anything it only sampled:')
// A hundred links over five days is a slice of each. Recomputing those days from
// the slice would replace a 400-link day's score with nine links of it.
check('  the ledger still gets every verdict', /saveJudgedLinks\(userId, day, perDay/.test(presence), true)
check('  the day score is left alone', /freshSince, false\)/.test(presence), true)
check('  which the writer supports on purpose', /refreshDay = true/.test(db), true)
check('  and says why', /fragment of itself/.test(db), true)
check('  the bulk sweep is still per day', /scoreUserDay\(/.test(sweep), true)

console.log('\nand it is still a read of what is there NOW:')
check('  an old verdict does not count as done', /freshSince \? 'AND checked_at >= \$4/.test(db), true)
check('  the cutoff reaches the verdict lookup', /getJudgedVerdicts\(userId, recent, freshSince\)/.test(presence), true)
check('  minted by the server', /await dbNow\(\)/.test(route), true)
check('  echoed by the client', /since \? \{ userId: u\.id, since \} : \{ userId: u\.id \}/.test(ui), true)
check('  and the loop resumes until nothing is left', /if \(d\.done\) break/.test(ui), true)

console.log('\nthe same video is read once, however often it was opened:')
// The same url can be in the list twice — clicked on two days — and it has one
// comment section either way. The verdict is then recorded against both days,
// because the ledger is keyed by day.
check('  one read per url', /ONE READ PER URL/.test(presence), true)
check('  recorded against every day it appears on', /for \(const day of byUrl\.get\(l\.url\) \?\? \[\]\)/.test(presence), true)

console.log('\nand the report says what was actually looked at:')
check('  how many links', /Their last \{verifyReport\.total\} link\(s\)/.test(ui), true)
check('  over how many days', /across \$\{verifyReport\.days\} day\(s\)/.test(ui), true)
check('  between which dates', /verifyReport\.from\} → \$\{verifyReport\.to\}/.test(ui), true)
check('  each link carries its day', /\{l\.day\.slice\(5\)\}/.test(ui), true)
check('  an unfinished pass says so', /still to read/.test(ui), true)
check('  unjudgeable links stay out of the percentage',
      /left out of the percentage rather than held/.test(route), true)
check('  and the button says what it will do', /Check \$\{who\}'s last 100 links\?/.test(ui), true)

// ── what this changes for real users ───────────────────────────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const { rows } = await pool
  .query(
    `WITH recent AS (
       SELECT user_id, url, clicked_at::date AS day,
              row_number() OVER (PARTITION BY user_id ORDER BY clicked_at DESC) AS rn
         FROM clicked_link
        WHERE url ILIKE '%tiktok.com%'
     ),
     last100 AS (
       SELECT user_id, count(*)::int AS links, count(DISTINCT day)::int AS days,
              min(day) AS oldest, max(day) AS newest
         FROM recent WHERE rn <= 100 GROUP BY user_id
     ),
     lastday AS (
       SELECT user_id, max(day) AS day FROM recent GROUP BY user_id
     )
     SELECT l.user_id, l.links, l.days, l.oldest, l.newest,
            (SELECT count(*)::int FROM clicked_link c
              WHERE c.user_id = l.user_id AND c.url ILIKE '%tiktok.com%'
                AND c.clicked_at::date = d.day) AS day_links
       FROM last100 l JOIN lastday d ON d.user_id = l.user_id
      ORDER BY day_links DESC
      LIMIT 6`
  )
  .catch(() => ({ rows: [] }))
console.log('\nwhat the two populations are, for the busiest users:')
for (const r of rows) {
  const ymd = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10)
  const span = ymd(r.oldest) === ymd(r.newest)
    ? ymd(r.oldest)
    : `${ymd(r.oldest)} → ${ymd(r.newest)}`
  console.log(
    `   ${String(r.user_id).slice(0, 8)}…  last 100: ${r.links} link(s) over ` +
      `${r.days} day(s) (${span})   last active day alone: ${r.day_links}`
  )
}
if (rows.length) {
  console.log('   The right-hand number is what the button used to read.')
}
await pool.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
