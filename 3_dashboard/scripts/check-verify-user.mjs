// Does the admin's per-user "verify" button check the last 300 links?
//
// The button has read three different populations. The first was the sample links
// the user chose to submit — they picked them, so it proved nothing. The second
// was every link they opened on their last active day, which is honest but not
// comparable: a day is whatever length it happens to be, so one user was judged
// on eleven links and another on 1,373, and the same user's number meant
// something different on Monday than on Tuesday.
//
// It now reads their last 300 links, across however many days those span — 300
// because the rate rule needs 200 JUDGED ones and about 15% of reads cannot be
// judged. Same
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

console.log('the button reads the last 300 links:')
check('  the size is named once', /export const RECENT_SAMPLE = 300/.test(presence), true)
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
check('  and the button says what it will do', /Check \$\{who\}'s last 300 links\?/.test(ui), true)

console.log('\nand it blocks a user with no comment on their last 50 judged links:')
// ONE DEFINITION OF THE RULE. The button, the manual sweep and the nightly cron
// all ask noCommentVerdict, so pressing the button cannot reach a different
// conclusion about somebody than the cron would overnight.
check('  the button asks the same rule', /noCommentVerdict\(/.test(route), true)
check('  at the same size', /BLOCK_SAMPLE$/m.test(route) || /BLOCK_SAMPLE\b/.test(route), true)
check('  which is 50', /export const BLOCK_SAMPLE = 50/.test(presence), true)
check('  the cron still asks it too', /noCommentVerdict\(/.test(read('app/api/cron/comment-presence/route.ts')), true)
// EVERY GUARD THAT MAKES IT CAUTIOUS STILL APPLIES.
check('  only once the check has finished', /if \(r\.remaining === 0\) \{/.test(route), true)
check('  a found comment ends the first rule', /found === 0/.test(presence), true)
check('  but not the second', /A HIT NO LONGER ENDS IT/.test(route), true)
check('  an admin\'s unblock is never overridden', /canBlock\(userId\)/.test(route), true)
// And a refusal says WHICH of the two reasons it was: 'already blocked' and
// 'on the exempt list' call for opposite next steps, and one real user sat on
// the exempt list while the message said 'already blocked, or exempt'.
check('  and a refusal names its reason', /auto-block exempt list/.test(route), true)
// A block that could not be written is never reported as one.
check('  a failed block is not reported as a block', /block could not be/.test(route), true)
check('  a small sample never blocks', /judged >= sample && found === 0/.test(presence), true)
check('  unreadable links are topped up, not counted as misses',
      /skipped links have to be replaced by/.test(presence), true)
// The block itself is the same one the sweep applies, down to the reason and the
// message, so a blocked user cannot tell which path blocked them.
check('  blocked as a TikTok-account problem', /blockUser\(userId, 'tiktok', true\)/.test(route), true)
check('  told, in the same words', /Your account has been paused/.test(route), true)
check('  and the badge says a machine did it', /auto = true/.test(route), true)

console.log('\nand the comments it found are kept, with how often each one was used:')
// NOTHING NEW IS STORED. Every found comment's text has been written to
// comment_presence_link since the check started capturing it, so the list is
// counted from the links it came from and cannot drift from them.
check('  the tally is read from the ledger', /export async function getFoundComments/.test(db), true)
check('  and not written anywhere new',
      /NOTHING NEW IS STORED/.test(db), true)
check('  the words come back with the verdict', /found, judgeable, comment_text/.test(db), true)
// The same comment posted twice is the same comment.
check('  grouped case- and space-blind', /GROUP BY lower\(btrim\(comment_text\)\)/.test(db), true)
check('  most-used first', /ORDER BY count\(\*\) DESC/.test(db), true)
check('  with the days it spans', /count\(DISTINCT day\) AS days/.test(db), true)
// THE FREQUENCY IS THE POINT: one comment on forty links is a person pasting one
// line all day, which reads as automation on the video itself.
check('  and why the frequency matters', /The frequency is the point/.test(db), true)
check('  the route returns it', /getFoundComments\(/.test(route), true)
check('  over the whole sample, not just this request',
      /including the links judged by an earlier request/.test(route), true)
check('  the report lists them', /comment\(s\) found/.test(ui), true)
check('  each with its count', /×\{c\.count\}/.test(ui), true)
check('  the most-repeated one is called out', /most-repeated: ×/.test(ui), true)
check('  a repeat is coloured differently', /amber-200 bg-amber-600\/15/.test(ui), true)
check('  and the words show on the link that carried them',
      /l\.found && l\.text/.test(ui), true)

console.log('\nand an unblock re-arms it instead of exempting them:')
// IT USED TO DO THE OPPOSITE. Every unblock inserted an auto_block_exempt row, on
// the reasoning that a machine must not overturn a person's decision — otherwise
// an unblock lasts until the nightly cron and undoes itself. In practice that made
// an unblock permanent immunity: six workers ended up outside the rule for good,
// invisibly, and a 0% check on one of them blocked nobody with no explanation.
check('  unblocking removes the exemption', /DELETE FROM auto_block_exempt WHERE user_id/.test(db), true)
check('  and does not add one', /INSERT INTO auto_block_exempt \(user_id\) VALUES/.test(db), false)
check('  the consequence is written down', /tonight's sweep will block them again/.test(db), true)
check('  and the dialog says it before you press', /RE-ARMS the automatic comment check/.test(ui), true)
// The table itself stays, readable, so a row put there by hand still protects
// somebody — there is simply nothing that writes one on its own.
check('  a hand-written exemption still counts', /FROM auto_block_exempt WHERE user_id = \$1\) AS exempt/.test(db), true)
check('  and the old behaviour is explained', /IT USED TO FILL ITSELF/.test(db), true)

console.log('\nand a second rule catches the person the first cannot:')
// THE GAP IN THE FIRST RULE. "Nothing on 50 links" is cleared completely by one
// comment anywhere. On the real data five users sat in that gap with 1, 2, 7, 10
// and 15 comments found across 200 judged links — commenting occasionally and
// claiming a full day.
check('  the rate rule exists', /export const RATIO_SAMPLE = 200/.test(presence), true)
check('  at ten percent', /export const RATIO_MIN_PCT = 10/.test(presence), true)
check('  either rule is enough', /rule: 'ratio'/.test(presence), true)
check('  and the first still ends it first', /rule: 'empty'/.test(presence), true)
// THE THRESHOLD IS MEASURED, not picked: 0-8% on one side, 11-36% on the other.
check('  the distribution is written down', /starts at 11%, running up to 36%/.test(presence), true)
// The denominator has to be REACHED. A user with 170 judged links is not judged.
check('  it needs the full sample', /ratio\.judged >= RATIO_SAMPLE/.test(presence), true)
check('  and says why', /they are not judged at\n \* all/.test(presence), true)
// FROM THE LEDGER, so it costs no TikTok reads and cannot blow a deadline —
// judging 200 links on demand is ten minutes per user.
check('  read from stored verdicts', /export async function getRecentJudgedRate/.test(db), true)
check('  reading nothing from TikTok', /reads nothing from\n \* TikTok/.test(db), true)
check('  the newest judged, not judged-among-newest', /NEWEST N JUDGED/.test(db), true)
check('  unreadable links are in neither half', /not a missing comment/.test(db), true)
// One definition, so all three callers get both rules.
check('  the cron gets both rules', /noCommentVerdict\(/.test(read('app/api/cron/comment-presence/route.ts')), true)
check('  and the manual sweep', /noCommentVerdict\(/.test(read('app/api/admin/comment-presence/route.ts')), true)
// And every report says WHICH rule fired.
check('  the verify report names the rule', /blocked\.rule === 'ratio'/.test(ui), true)
check('  with the percentage it acted on', /judged links carry their comment/.test(ui), true)
check('  the sweep badge too', /Auto-blocked by this sweep: only/.test(ui), true)
check('  and the warning names both', /or under 10% of their last 200 judged links/.test(ui), true)

console.log('\nand it says what it did, either way:')
// A button that can block somebody must never be silent about not having.
check('  a block is reported', /blocked,/.test(route), true)
check('  and a non-block explains itself', /blockNote/.test(route), true)
check('  the warning is given BEFORE it runs', /will be BLOCKED/.test(ui), true)
check('  and that it can be undone', /unblock them again/.test(ui), true)
check('  the report shows the block', /Blocked automatically — signed out now/.test(ui), true)
check('  with how many links it rested on', /judged link\(s\)/.test(ui), true)
check('  and the skips that were not held against them',
      /were not counted against them/.test(ui), true)
check('  a non-block is shown too', /Auto-block rules \(/.test(ui), true)

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
     last300 AS (
       SELECT user_id, count(*)::int AS links, count(DISTINCT day)::int AS days,
              min(day) AS oldest, max(day) AS newest
         FROM recent WHERE rn <= 300 GROUP BY user_id
     ),
     lastday AS (
       SELECT user_id, max(day) AS day FROM recent GROUP BY user_id
     )
     SELECT l.user_id, l.links, l.days, l.oldest, l.newest,
            (SELECT count(*)::int FROM clicked_link c
              WHERE c.user_id = l.user_id AND c.url ILIKE '%tiktok.com%'
                AND c.clicked_at::date = d.day) AS day_links
       FROM last300 l JOIN lastday d ON d.user_id = l.user_id
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
    `   ${String(r.user_id).slice(0, 8)}…  last 300: ${r.links} link(s) over ` +
      `${r.days} day(s) (${span})   last active day alone: ${r.day_links}`
  )
}
if (rows.length) {
  console.log(
    '   The right-hand number is ONE DAY of theirs, which is what the button read ' +
      'before\n   it read a fixed 300: the same person was judged on 350 links one ' +
      'day and 11 the next.'
  )
}

// ── WHO WOULD THE BLOCK RULE CATCH, on what is already in the ledger? ───────
//
// A lower bound, and worth having before anybody presses the button: this counts
// only links ALREADY judged, so a user whose recent links have never been read
// shows as "not enough judged" here and could still be blocked once the button
// reads them. It walks each user's recent clicks newest-first, exactly as
// noCommentVerdict does, stopping at 50 judged.
const { rows: pool2 } = await pool
  .query(
    `WITH r AS (
       SELECT c.user_id, c.url, c.clicked_at::date AS day, c.clicked_at,
              row_number() OVER (PARTITION BY c.user_id ORDER BY c.clicked_at DESC) AS rn
         FROM clicked_link c
        WHERE c.url ILIKE '%tiktok.com%'
     )
     SELECT r.user_id, r.rn, l.found, l.judgeable
       FROM r
       LEFT JOIN comment_presence_link l
         ON l.user_id = r.user_id AND l.url = r.url AND l.day = r.day
      WHERE r.rn <= 300
        AND NOT EXISTS (SELECT 1 FROM blocked_user b WHERE b.user_id = r.user_id)
        AND NOT EXISTS (SELECT 1 FROM auto_block_exempt e WHERE e.user_id = r.user_id)
      ORDER BY r.user_id, r.rn`
  )
  .catch(() => ({ rows: [] }))
const per = new Map()
for (const row of pool2) {
  const cur = per.get(row.user_id) ?? { judged: 0, found: 0, skipped: 0, unread: 0 }
  if (cur.judged >= 50 || cur.found > 0) {
    per.set(row.user_id, cur)
    continue
  }
  if (row.judgeable === null) cur.unread++
  else if (row.judgeable) {
    cur.judged++
    if (row.found) cur.found++
  } else cur.skipped++
  per.set(row.user_id, cur)
}
const would = []
let short = 0
for (const [id, v] of Array.from(per.entries())) {
  if (v.found === 0 && v.judged >= 50) would.push({ id, ...v })
  else if (v.found === 0) short++
}
console.log('\nwho the rule would catch on verdicts already stored:')
console.log(
  `   ${would.length} user(s) have 50+ judged links and a comment on none of them` +
    ` — pressing the button on one of those blocks them`
)
console.log(
  `   ${short} more have no comment found but not yet 50 judged links, so the button` +
    ` would read more of their links first`
)
for (const w of would.slice(0, 8)) {
  console.log(
    `     ${String(w.id).slice(0, 8)}…  0 found of ${w.judged} judged` +
      `${w.skipped ? `, ${w.skipped} unreadable` : ''}`
  )
}
await pool.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
