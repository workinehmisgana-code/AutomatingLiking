// Does the account-creation date the dashboard now shows actually hold up?
//
// Two things are being checked, and they fail for different reasons.
//
//  1. The decoder itself. lib/tiktokId divides by 2^32 instead of shifting by
//     32 bits, because BigInt literals need an ES2020 target and that file is
//     compiled into the browser bundle. Division and shifting agree for
//     positive integers — but that is an assumption worth executing rather than
//     asserting, along with the cases that must return NOTHING rather than a
//     wrong date.
//
//  2. The pipeline, end to end, against real users. For each user whose comment
//     a presence check found, this re-reads one of those links exactly as the
//     route does, takes the uid off their comment, and checks the decoded date
//     against the hard constraint: an account cannot post a comment before it
//     exists.
//
//   node scripts/check-account-created.mjs
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
  console.log(
    `   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
  )
}

// Mirrors lib/tiktokId.accountCreatedAt.
const FLOOR_SEC = 1451606400
function createdAt(uid) {
  const raw = String(uid ?? '').trim()
  if (!/^\d+$/.test(raw)) return null
  let secs
  try {
    const n = BigInt(raw)
    if (n <= BigInt(0)) return null
    secs = Number(n / BigInt(4294967296))
  } catch {
    return null
  }
  if (secs < FLOOR_SEC) return null
  const ms = secs * 1000
  if (ms > Date.now() + 86_400_000) return null
  return new Date(ms)
}
const day = (d) => (d ? d.toISOString().slice(0, 10) : null)

console.log('the decoder:')
// Division must agree with the shift the probe used, across the whole range of
// real ids — the top bits are what both are reading.
let disagreements = 0
for (let i = 0; i < 20000; i++) {
  const secs = FLOOR_SEC + Math.floor(Math.random() * 300_000_000)
  const low = Math.floor(Math.random() * 4294967296)
  const id = (BigInt(secs) << BigInt(32)) + BigInt(low)
  if (Number(id / BigInt(4294967296)) !== Number(id >> BigInt(32))) disagreements++
}
check('division matches a 32-bit shift over 20k ids', disagreements, 0)

// A known-good id, built from a date, must decode back to that date.
const built = (BigInt(Math.floor(Date.UTC(2021, 2, 12) / 1000)) << BigInt(32)) + BigInt(12345)
check('an id built from a date decodes back to it', day(createdAt(built.toString())), '2021-03-12')

// The cases that must produce nothing rather than a plausible-looking lie.
check('a handle instead of an id', createdAt('joewritesbetter'), null)
check('empty', createdAt(''), null)
check('null', createdAt(null), null)
check('zero', createdAt('0'), null)
check('a short pre-snowflake id', createdAt('6543210'), null)
check('a negative-looking id', createdAt('-7000000000000000000'), null)
const future = (BigInt(Math.floor(Date.now() / 1000) + 400_000) << BigInt(32)).toString()
check('a date in the future', createdAt(future), null)

// ── The real thing ───────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await pool.query(sql, p)).rows

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0 Safari/537.36'

const users = await q(
  `SELECT DISTINCT ON (l.user_id)
          l.user_id, l.url, p.tiktok_url
     FROM comment_presence_link l
     JOIN user_profile p ON p.user_id = l.user_id
    WHERE l.found AND p.tiktok_url IS NOT NULL AND p.tiktok_url <> ''
    ORDER BY l.user_id, l.day DESC, l.checked_at DESC`
)
console.log(`\nreal users with a found comment: ${users.length}`)

const stored = await q('SELECT user_id, handle, uid FROM tiktok_account')
console.log(`ids already captured by presence checks: ${stored.length}`)

let resolved = 0
let violations = 0
for (const u of users.slice(0, 6)) {
  const handle = (u.tiktok_url.match(/@([^/?#\s]+)/)?.[1] ?? '').toLowerCase()
  const vid = u.url.match(/\/(?:video|photo)\/(\d+)/)?.[1]
  if (!handle || !vid) continue
  let hit = null
  for (let page = 0, cursor = 0; page < 4 && !hit; page++) {
    try {
      const res = await fetch(
        `https://www.tiktok.com/api/comment/list/?aweme_id=${vid}&count=50&cursor=${cursor}&aid=1988`,
        { headers: { 'User-Agent': UA, Referer: u.url } }
      )
      const body = await res.text()
      if (!body.trim()) break
      const data = JSON.parse(body)
      const list = data.comments ?? []
      hit = list.find((c) => String(c.user?.unique_id ?? '').toLowerCase() === handle) ?? null
      if (!data.has_more || list.length === 0) break
      cursor = Number(data.cursor) || cursor + list.length
    } catch {
      break
    }
  }
  if (!hit?.user?.uid) {
    console.log(`   @${handle}: comment not on the page any more — route reports "unknown"`)
    continue
  }
  const acct = createdAt(hit.user.uid)
  const wrote = createdAt(hit.cid)
  resolved++
  // The hard constraint: the account must predate the comment it wrote.
  const bad = acct && wrote && acct > wrote
  if (bad) violations++
  console.log(
    `   @${handle}: uid ${hit.user.uid} -> created ${day(acct) ?? 'no date'}` +
      (wrote ? ` · commented ${day(wrote)}` : '') +
      (bad ? '  <-- IMPOSSIBLE' : '')
  )
}

console.log('')
check('every resolved account predates its own comment', violations, 0)
if (resolved === 0) {
  console.log('   note: nothing resolved live — TikTok served no matching comment this run.')
}

await pool.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
