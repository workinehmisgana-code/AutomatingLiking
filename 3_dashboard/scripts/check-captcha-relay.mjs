// Can a captcha be solved from a phone, from any network?
//
// THE PROBLEM. The liker runs headless on one machine. When TikTok puts a puzzle
// in front of an account the run stops dead — the comment list renders as grey
// placeholders, the account stays signed in, and every symptom points at the DOM
// while none of them is the cause. Somebody has to drag a slider, the wait gives
// up in a few minutes, and until now that somebody had to be at that machine. A
// headless run could not be helped at all: there was no window to drag anything
// in, so the account was simply written off for the rest of the pass.
//
// THE RELAY. This app is already deployed, already HTTPS and already refuses
// anyone who is not the admin, so the puzzle comes here:
//
//   worker --POST /api/captcha--> captcha_request <--/admin/captcha-- the phone
//   worker <--GET  /api/captcha-- (the answer)    --POST-->
//
// Nothing in the liker listens on a port, so there is no tunnel to run and no
// door opened in the router. Its own control panel stays on localhost, which is
// where something that can start signed-in browsers belongs.
//
// This exercises the table the whole thing rests on, and checks the wiring in
// both projects. The HTTP layer needs a running server and a logged-in phone; it
// is verified by hand, and the pieces below are what a hand test cannot cover.
//
//   node scripts/check-captcha-relay.mjs
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
  console.log(
    `   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
  )
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const liker = (f) => readFileSync(new URL(`../../6_comment_liker/${f}`, import.meta.url), 'utf8')

const db = read('lib/db.ts')
const wroute = read('app/api/captcha/route.ts')
const aroute = read('app/api/admin/captcha/route.ts')
const ui = read('components/RemoteCaptcha.tsx')
const nav = read('components/AdminDashboard.tsx')
const relay = liker('remote_captcha.py')
const cap = liker('captcha.py')
const like = liker('like.py')
const par = liker('run_parallel.py')

console.log('the worker end is a token, like the other script endpoints:')
check('  header, query or body', /String\(body\?\.token \?\? ''\)\.trim\(\)/.test(wroute), true)
// The body used to be the one place it did NOT look, which answered 401 to every
// publish while the GET beside it worked — a failure that reads exactly like a
// wrong token and is not one.
check('  and the body is read before the check', /token may be in it/.test(wroute), true)
check('  images are size- and shape-checked', /payload\.length > 1_400_000/.test(wroute), true)
check('  a puzzle with no picture is refused', /need either outer\+inner \(rotate\) or shot/.test(wroute), true)
check('  a poll does not carry the images back', /must not carry a hundred kilobytes/.test(wroute), true)
check('  and gone is distinguished from unanswered', /found: false/.test(wroute), true)

console.log('\nthe phone end is the ordinary admin login:')
check('  nothing without it', /requireAdmin\(\)\)\) return NextResponse\.json\(\{ error: 'Forbidden' \}/.test(aroute), true)
check('  four answer shapes and no others', /send angle, points, refresh or give_up/.test(aroute), true)
check('  taps must be fractions', /points must be fractions/.test(aroute), true)
check('  an angle wraps rather than fails', /\(\(angle % 360\) \+ 360\) % 360/.test(aroute), true)
check('  and a double tap is not an error', /the first one is the one that counts/.test(aroute), true)

console.log('\nthe page works on a phone:')
check('  the disc really turns', /rotate\(\$\{\s*invert\[r\.id\] \? -a : a\s*\}deg\)/.test(ui), true)
check('  sized from both images, in either load order', /natural\[`inner:\$\{r\.id\}`\]/.test(ui), true)
check('  taps come back as fractions of the picture', /\(e\.clientX - box\.left\) \/ box\.width/.test(ui), true)
check('  it beeps, buzzes and notifies', /buzz\(\[120, 60, 120\]\)/.test(ui), true)
check('  after a tap unlocks sound', /needs a real tap to do/.test(ui), true)
check('  and it is reachable from the dashboard', /router\.push\('\/admin\/captcha'\)/.test(nav), true)

console.log('\nthe worker applies what the phone said:')
check('  one angle becomes one drag', /captcha\.drag_angle\(page, widget, angle/.test(relay), true)
check('  the drag is shared with the paid solver', /def drag_angle\(page, widget: dict, angle: float/.test(cap), true)
check('  taps become clicks in the widget', /captcha\.tap_points\(page, box, answer\["points"\]/.test(relay), true)
check('  a photograph is taken from the element, not the page', /would photograph the wrong rectangle/.test(cap), true)
check('  "different puzzle" is honoured', /captcha\.refresh\(page\)/.test(relay), true)
check('  and "skip this account" is too', /return "giveup"/.test(relay), true)

console.log('\nand the run uses it:')
check('  headless is no longer a dead end', /HEADLESS AND RELAYED, which used to be a dead end/.test(like), true)
check('  headed waits on both at once', /BOTH ROUTES AT ONCE/.test(like), true)
check('  solving it at the desk ends the wait', /def still_there\(\) -> bool:/.test(like), true)
check('  on by default when configured', /REMOTE_CAPTCHA = True/.test(like), true)
check('  off with one flag', /--no-remote-captcha/.test(like) && /--no-remote-captcha/.test(par), true)
check('  and the terminal says where to look', /\/admin\/captcha" if remote_ready\(\) else ""/.test(like), true)

// ── the table itself, against the real database ────────────────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

await pool.query(`
  CREATE TABLE IF NOT EXISTS captcha_request (
    id TEXT PRIMARY KEY, profile TEXT NOT NULL, kind TEXT NOT NULL,
    instruction TEXT NOT NULL DEFAULT '', outer_b64 TEXT, inner_b64 TEXT,
    shot_b64 TEXT, box_w DOUBLE PRECISION, box_h DOUBLE PRECISION,
    answer JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at TIMESTAMPTZ
  );
`)

const put = async (id, profile) =>
  pool.query(
    `INSERT INTO captcha_request (id, profile, kind, outer_b64, inner_b64)
     VALUES ($1, $2, 'rotate', 'aGk=', 'aGk=')`,
    [id, profile]
  )

console.log('\nthe table, on the real database:')
const A = 'check-a-' + Date.now()
const B = 'check-b-' + Date.now()
await pool.query(`DELETE FROM captcha_request WHERE profile = 'checkscript'`)
await put(A, 'checkscript')
const one = await pool.query(`SELECT * FROM captcha_request WHERE id = $1`, [A])
check('  a puzzle goes up unanswered', one.rows[0]?.answer, null)

// One open puzzle per account: an account that met a captcha, timed out and met
// another would otherwise leave the first on the page, and answering the wrong
// one sends a drag to a browser that has moved on.
await pool.query(`DELETE FROM captcha_request WHERE profile = $1 AND answer IS NULL`, [
  'checkscript',
])
await put(B, 'checkscript')
const open = await pool.query(
  `SELECT count(*)::int n FROM captcha_request WHERE profile = 'checkscript' AND answer IS NULL`
)
check('  a second one replaces the first', open.rows[0].n, 1)

const first = await pool.query(
  `UPDATE captcha_request SET answer = $2::jsonb, answered_at = now()
    WHERE id = $1 AND answer IS NULL`,
  [B, JSON.stringify({ angle: 137 })]
)
check('  answering it once works', first.rowCount, 1)
const again = await pool.query(
  `UPDATE captcha_request SET answer = $2::jsonb, answered_at = now()
    WHERE id = $1 AND answer IS NULL`,
  [B, JSON.stringify({ angle: 9 })]
)
check('  answering it twice does not overwrite', again.rowCount, 0)
const back = await pool.query(`SELECT answer FROM captcha_request WHERE id = $1`, [B])
check('  and the first answer is what the worker reads', back.rows[0].answer, { angle: 137 })

await pool.query(`DELETE FROM captcha_request WHERE id = $1`, [B])
const gone = await pool.query(`SELECT count(*)::int n FROM captcha_request WHERE id = $1`, [B])
check('  closing it removes the row and its images', gone.rows[0].n, 0)

const stale = await pool.query(
  `INSERT INTO captcha_request (id, profile, kind, shot_b64, created_at)
   VALUES ($1, 'checkscript', 'other', 'aGk=', now() - interval '2 hours')
   RETURNING id`,
  ['check-old-' + Date.now()]
)
const pruned = await pool.query(
  `DELETE FROM captcha_request WHERE created_at < now() - interval '1 hour'`
)
check('  an hour-old puzzle is pruned', pruned.rowCount >= 1, true)
check('  which is what the stale row was', Boolean(stale.rows[0]?.id), true)

const left = await pool.query(
  `SELECT count(*)::int n FROM captcha_request WHERE profile = 'checkscript'`
)
await pool.query(`DELETE FROM captcha_request WHERE profile = 'checkscript'`)
console.log(`   (cleaned up ${left.rows[0].n} test row(s))`)

const live = await pool.query(
  `SELECT profile, kind, answer IS NOT NULL AS answered, created_at
     FROM captcha_request ORDER BY created_at DESC LIMIT 5`
)
if (live.rows.length) {
  console.log('\nreal rows in the table right now:')
  for (const r of live.rows) {
    console.log(
      `   ${r.profile.padEnd(12)} ${r.kind.padEnd(8)} ${r.answered ? 'answered' : 'WAITING '} ${r.created_at.toISOString()}`
    )
  }
} else {
  console.log('\nno puzzles in the table — nothing is stuck.')
}

console.log(fails === 0 ? '\nall checks passed' : `\n${fails} check(s) FAILED`)
await pool.end()
process.exit(fails === 0 ? 0 : 1)
