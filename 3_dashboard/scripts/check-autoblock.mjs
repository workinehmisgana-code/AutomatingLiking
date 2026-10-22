// Why does the nightly presence check block nobody, when the button blocks some?
//
// Both call noCommentVerdict, so they cannot disagree about a person. What they
// do not share is WHEN they get to ask: the button is driven by the admin's
// browser in a tight loop until the window is finished, and the cron gets one
// 50-second slice every five minutes and stops at the first user who is not
// finished. This prints what the ledger says about that race.
//
//   node scripts/check-autoblock.mjs
import { readFileSync } from 'node:fs'

// ── the pin, before anything touches the database ───────────────────────────
//
// Mirrors windowPin() in app/api/cron/comment-presence/route.ts. Every run of
// one night MUST return the same instant: that is the whole mechanism by which
// a window converges instead of being chased.
const START = Number(process.env.PRESENCE_WINDOW_START_HOUR || 17)
function windowPin(now) {
  const pin = new Date(now)
  pin.setUTCMinutes(0, 0, 0)
  if (now.getUTCHours() < START) pin.setUTCDate(pin.getUTCDate() - 1)
  pin.setUTCHours(START)
  return pin.toISOString()
}
let pinFails = 0
for (const [at, want, why] of [
  ['2026-10-13T17:05:00Z', '2026-10-13T17:00:00.000Z', 'first run of the night'],
  ['2026-10-13T23:55:00Z', '2026-10-13T17:00:00.000Z', 'last run of the night'],
  ['2026-10-14T00:10:00Z', '2026-10-13T17:00:00.000Z', 'after midnight, still that night'],
  ['2026-10-14T11:42:00Z', '2026-10-13T17:00:00.000Z', 'next morning, by hand'],
  ['2026-11-01T02:00:00Z', '2026-10-31T17:00:00.000Z', 'across a month'],
  ['2027-01-01T03:00:00Z', '2026-12-31T17:00:00.000Z', 'across a year'],
]) {
  const got = windowPin(new Date(at))
  if (got !== want) { pinFails++; console.log(`  FAIL ${at} -> ${got} (want ${want}, ${why})`) }
}
const oneNight = new Set(['17:05', '18:20', '20:00', '22:30', '23:55']
  .map((t) => windowPin(new Date(`2026-10-13T${t}:00Z`))))
if (oneNight.size !== 1) { pinFails++; console.log(`  FAIL a night produced ${oneNight.size} pins`) }
console.log(pinFails === 0
  ? 'window pin: every run of a night agrees on one instant.\n'
  : `window pin: ${pinFails} case(s) wrong, so windows will not converge.\n`)

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const q = async (s, p = []) => (await db.query(s, p)).rows

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—')

try {
  // ── the rules, which both callers read from here ─────────────────────────
  const kv = await q(`SELECT key, value FROM app_kv WHERE key LIKE '%block%'`).catch(() => [])
  console.log('block rules in app_kv:')
  if (!kv.length) console.log('  (none stored — the code defaults apply)')
  for (const r of kv) console.log(`  ${r.key} = ${JSON.stringify(r.value)}`)

  // ── have any blocks ever been written by the machine? ────────────────────
  const blocks = await q(
    `SELECT auto, reason, count(*)::int n, min(blocked_at) first, max(blocked_at) last
       FROM blocked_user GROUP BY auto, reason ORDER BY auto, reason`
  )
  console.log('\nblocks on record:')
  for (const b of blocks) {
    console.log(`  auto=${String(b.auto).padEnd(5)} reason=${String(b.reason).padEnd(8)} ${String(b.n).padStart(4)}  ${iso(b.first)} .. ${iso(b.last)}`)
  }
  const autoCount = blocks.filter((b) => b.auto).reduce((a, b) => a + b.n, 0)
  console.log(`  → ${autoCount} automatic, ${blocks.reduce((a, b) => a + b.n, 0) - autoCount} by a person`)

  // ── exempt list: an exempt user can never be auto-blocked ────────────────
  const ex = await q(`SELECT count(*)::int n FROM auto_block_exempt`)
  console.log(`\n${ex[0].n} user(s) on the auto-block exempt list.`)

  // ── THE RACE. For everyone who clicked today, how much of their window is
  //    judged inside the cron's 6-hour freshness horizon? remaining must hit 0
  //    in ONE run for a verdict to be reached at all.
  const RECENT = 300
  const FRESH_HOURS = Number(process.env.PRESENCE_FRESH_HOURS || 6)
  const today = new Date().toISOString().slice(0, 10)
  const clickers = await q(
    `SELECT c.user_id, p.name, p.tiktok_url, count(*)::int AS clicks
       FROM clicked_link c
       JOIN user_profile p ON p.user_id = c.user_id
       JOIN "user" au ON au.id = c.user_id
      WHERE c.clicked_at::date = $1::date
        AND c.url ILIKE '%tiktok.com%'
        AND p.tiktok_url IS NOT NULL AND p.tiktok_url <> ''
        AND NOT EXISTS (SELECT 1 FROM blocked_user b WHERE b.user_id = c.user_id)
      GROUP BY c.user_id, p.name, p.tiktok_url
      ORDER BY count(*) DESC`,
    [today]
  )
  console.log(`\n${clickers.length} clicker(s) today (${today}); the cron walks them in order and`)
  console.log(`stops at the first whose window is not finished.\n`)

  // The pin the cron now uses: the most recent 17:00 UTC boundary. Mirrors
  // windowPin() in app/api/cron/comment-presence/route.ts - if the two ever
  // disagree, this report is measuring a window the cron does not read.
  const START_HOUR = Number(process.env.PRESENCE_WINDOW_START_HOUR || 17)
  const pin = new Date()
  pin.setUTCMinutes(0, 0, 0)
  if (pin.getUTCHours() < START_HOUR) pin.setUTCDate(pin.getUTCDate() - 1)
  pin.setUTCHours(START_HOUR)
  console.log(`window pin: ${iso(pin)} (links opened before this)\n`)

  let stuckAt = null
  let movedTotal = 0
  let pinnedTotal = 0
  for (const c of clickers.slice(0, 12)) {
    // Their newest RECENT links, as getRecentClickedLinks returns them.
    const win = await q(
      `SELECT url, clicked_at::date::text AS day
         FROM clicked_link WHERE user_id = $1 AND url ILIKE '%tiktok.com%'
        ORDER BY clicked_at DESC, url LIMIT $2`,
      [c.user_id, RECENT]
    )
    const urls = win.map((w) => w.url)
    const days = win.map((w) => w.day)
    const fresh = await q(
      `SELECT count(*)::int n FROM comment_presence_link
        WHERE user_id = $1
          AND (url, day) IN (SELECT u, d::date FROM unnest($2::text[], $3::text[]) AS x(u, d))
          AND checked_at >= now() - ($4 || ' hours')::interval`,
      [c.user_id, urls, days, String(FRESH_HOURS)]
    )
    const ever = await q(
      `SELECT count(*)::int n, max(checked_at) last FROM comment_presence_link
        WHERE user_id = $1
          AND (url, day) IN (SELECT u, d::date FROM unnest($2::text[], $3::text[]) AS x(u, d))`,
      [c.user_id, urls, days]
    )
    // How fast their window is moving: links opened since the last judgement.
    const added = await q(
      `SELECT count(*)::int n FROM clicked_link
        WHERE user_id = $1 AND url ILIKE '%tiktok.com%'
          AND clicked_at > COALESCE($2::timestamptz, 'epoch')`,
      [c.user_id, ever[0].last]
    )
    // THE SAME QUESTION, ASKED OF THE PINNED WINDOW. This is the whole fix:
    // the links opened before the pin cannot be pushed out by today's clicking,
    // so whatever has been judged of them stays judged.
    const pinWin = await q(
      `SELECT url, clicked_at::date::text AS day
         FROM clicked_link WHERE user_id = $1 AND url ILIKE '%tiktok.com%'
           AND clicked_at < $3::timestamptz
        ORDER BY clicked_at DESC, url LIMIT $2`,
      [c.user_id, RECENT, pin.toISOString()]
    )
    const pinJudged = pinWin.length
      ? await q(
          `SELECT count(*)::int n FROM comment_presence_link
            WHERE user_id = $1
              AND (url, day) IN (SELECT u, d::date FROM unnest($2::text[], $3::text[]) AS x(u, d))`,
          [c.user_id, pinWin.map((w) => w.url), pinWin.map((w) => w.day)]
        )
      : [{ n: 0 }]

    const left = win.length - fresh[0].n
    const handle = (String(c.tiktok_url || '').match(/@([^/?#\s]+)/) || [])[1] || ''
    const mark = !handle ? 'SKIPPED - no @username' : left === 0 ? 'FINISHED' : `${left} left`
    console.log(`  ${String(c.name || c.user_id).slice(0, 22).padEnd(22)} tiktok clicks today ${String(c.clicks).padStart(4)}  window ${String(win.length).padStart(3)}  judged-fresh ${String(fresh[0].n).padStart(3)}  ${mark}`)
    console.log(`  ${''.padEnd(22)} ever judged ${String(ever[0].n).padStart(3)}, last ${iso(ever[0].last)}, ${added[0].n} link(s) opened since`)
    const pinLeft = pinWin.length - pinJudged[0].n
    console.log(`  ${''.padEnd(22)} PINNED window ${String(pinWin.length).padStart(3)}, already judged ${String(pinJudged[0].n).padStart(3)}, ${pinLeft} left`)
    movedTotal += left
    pinnedTotal += pinLeft
    // scoreUserRecent returns null without a handle, and `if (r && ...) break`
    // is then false - so those users are skipped, not stuck on.
    // Judged against the PINNED window, because that is the one the cron reads
    // now. The moving figure above is kept for contrast: it is what the check
    // was chasing before, and why it never finished anybody.
    if (handle && pinLeft > 0 && stuckAt === null) stuckAt = c
  }
  if (clickers.length > 12) console.log(`  … and ${clickers.length - 12} more`)

  console.log(`\nAcross the users shown: ${movedTotal} link(s) left to judge on the moving`)
  console.log(`window, ${pinnedTotal} on the pinned one. The difference is work already done`)
  console.log(`that the moving window was throwing away every day.`)

  if (stuckAt) {
    console.log(`\nThe cron stops at: ${stuckAt.name || stuckAt.user_id}`)
    console.log('The loop restarts from the top each run and breaks on the first unfinished')
    console.log('user, so they absorb the runs until their pinned window is done - which it now')
    console.log('can be, since it stands still.')
  } else {
    console.log('\nNo clicker today has an unfinished window, so the cron would reach a verdict')
    console.log('for each of them.')
  }
} finally {
  await db.end()
}
