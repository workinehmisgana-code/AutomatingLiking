// What users write, in front of the admin the moment they arrive.
//
// These messages had nowhere to be. A reply lived inside that user's own card,
// three hundred cards down a list sorted by clicks, and the only way to find
// one was to already know it was there. Twenty-one were waiting when this was
// built, including:
//
//     "How can i contact u or should i give u my telegram username?"
//
// asked two days earlier, by somebody still waiting for an answer.
//
// TWO RULES the popup is built around, and both are checked here:
//
//   CLOSING IS NOT READING. Only "Done" marks a message dealt with. A message
//   dismissed by accident is one nobody answers, and the person who sent it
//   waits for a reply that never comes.
//
//   ANSWERING IS THE POINT. A notification that only says something happened
//   makes work. The reply box is in the popup, and sending clears the message
//   in the same press.
//
//   node scripts/check-user-messages.mjs
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

const db = read('lib/db.ts')
const popup = read('components/UserMessagesPopup.tsx')
const route = read('app/api/admin/replies-read/route.ts')
const page = read('app/admin/page.tsx')

console.log('what is unread, and what the popup gets told')
check('  a table of what has been dealt with', /CREATE TABLE IF NOT EXISTS admin_reply_read/.test(db), true)
// Per reply, not one "last looked at" time: a watermark marks everything read
// the moment the admin glances at the page.
check('  keyed per message', /reply_id BIGINT PRIMARY KEY/.test(db), true)
check('  and the reason is written down', /a watermark\s*\n?\s*--\s*marks everything read/.test(db), true)
check('  unread is what has no mark', /WHERE NOT EXISTS \(SELECT 1 FROM admin_reply_read x WHERE x\.reply_id = r\.id\)/.test(db), true)
check('  newest first', /ORDER BY r\.created_at DESC/.test(db), true)
// An inbox nobody has opened for a month is still a popup somebody must get past.
check('  and capped', /LIMIT \$1/.test(db), true)
// A reply without the message it answers is a sentence about nothing.
check('  it carries what they replied to', /m\.body AS to_message/.test(db), true)
check('  and how to reach them', /p\.phone, p\.telegram/.test(db), true)

console.log('\nmarking one read is deliberate and survives')
check('  an endpoint of its own', /export async function POST/.test(route), true)
check('  which refuses a non-admin', /Forbidden/.test(route), true)
check('  idempotent', /ON CONFLICT \(reply_id\) DO NOTHING/.test(db), true)
// The popup shows the server's list after every change: two admins on two
// phones would otherwise each see their own idea of what is left.
check('  and answers with the list that is left', /replies: await getUnreadReplies\(\)/.test(route), true)
check('  which the popup uses instead of its own', /const left: UnreadReply\[\] = j\.replies/.test(popup), true)

console.log('\nclosing keeps them')
check('  Close only hides it', /onClick=\{\(\) => setOpen\(false\)\}/.test(popup), true)
check('  and says so', /Closing this keeps them/.test(popup), true)
// Closed but unanswered, the messages stay one press away.
check('  a bar is left behind', /unanswered message/.test(popup), true)
check('  Esc works too', /e\.key === 'Escape'/.test(popup), true)
// A modal that traps somebody who only wanted the page behind it is worse than
// no modal.
check('  and clicking the backdrop', /e\.target === e\.currentTarget/.test(popup), true)

console.log('\nanswering is possible from inside it')
check('  there is a reply box', /placeholder="Reply…"/.test(popup), true)
check('  it posts to the message endpoint', /'\/api\/admin\/message'/.test(popup), true)
check('  to that user, not everybody', /userId: r\.userId/.test(popup), true)
// Answered is dealt with; leaving it unread means answering it twice tomorrow.
check('  and sending clears the message', /await markRead\(\[r\.id\]\)/.test(popup), true)
check('  Enter sends', /e\.key === 'Enter'/.test(popup), true)

console.log('\nit is on screen with the first paint, not a second later')
check('  fetched with the page', /getUnreadReplies\(\)\.catch/.test(page), true)
check('  and rendered before the dashboard',
      page.indexOf('<UserMessagesPopup') < page.indexOf('<AdminDashboard'), true)

console.log('\nand a read-mark never outlives what it describes')
// Ids are a sequence. A mark left behind can only ever say that some future
// reply has already been dealt with.
check('  deleting one reply takes its mark',
      /DELETE FROM admin_reply_read WHERE reply_id = \$1/.test(db), true)
check('  deleting a message takes all of theirs',
      /DELETE FROM admin_reply_read WHERE reply_id IN\s*\n?\s*\(SELECT id FROM message_reply WHERE message_id = \$1\)/.test(db), true)
check('  and deleting a user takes theirs',
      /\(SELECT id FROM message_reply WHERE user_id = \$1\)/.test(db), true)

console.log('\nagainst the real database')
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const cols = (
  await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'admin_reply_read' ORDER BY column_name`
  )
).rows.map((r) => r.column_name)
check('  the table is there', cols, ['read_at', 'reply_id'])
const counts = (
  await pool.query(
    `SELECT (SELECT count(*)::int FROM message_reply) AS total,
            (SELECT count(*)::int FROM admin_reply_read) AS done`
  )
).rows[0]
console.log(`   ${counts.total} message(s) from users, ${counts.done} marked done, `
  + `${counts.total - counts.done} waiting`)
// A mark for a reply that no longer exists would be exactly the bug the three
// deletes above prevent.
const orphans = (
  await pool.query(
    `SELECT count(*)::int n FROM admin_reply_read x
      WHERE NOT EXISTS (SELECT 1 FROM message_reply r WHERE r.id = x.reply_id)`
  )
).rows[0].n
check('  no mark points at a message that is gone', orphans, 0)
await pool.end()

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
