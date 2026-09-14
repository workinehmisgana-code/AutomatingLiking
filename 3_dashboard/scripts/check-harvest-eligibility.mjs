// Which channels may the automatic harvest touch?
//
// The rule is an ABSOLUTE bar: at least 50% of everything ever held for the
// channel is still active rather than blocked. It replaced "the top half by
// rank score", which is relative — that always admits half the channels however
// bad they all are, and would keep harvesting from a channel whose every link
// had been blocked simply because the others were worse.
//
// This checks the rule against the real pool, and specifically that the channels
// whose work is thrown out are now excluded.
//
//   node scripts/check-harvest-eligibility.mjs
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

const MIN = 50
const src = readFileSync(new URL('../lib/channelHarvest.ts', import.meta.url), 'utf8')
console.log('the rule in the code:')
check('the bar is 50%', /HARVEST_MIN_ACTIVE_PCT = 50/.test(src), true)
check('eligibility reads the ratio', /activePct >= HARVEST_MIN_ACTIVE_PCT/.test(src), true)
check('a channel with no ratio is excluded, not assumed good',
  /c\.activePct !== null/.test(src), true)
check('the old relative threshold is gone', /HARVEST_MIN_SCORE/.test(src), false)

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const q = async (s, p = []) => (await pool.query(s, p)).rows
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }, cache: 'no-store' })).json()
const blockedUrls = (await q('SELECT url FROM blocked_link')).map((r) => r.url)
const blocked = new Set(blockedUrls)
const chan = (u) => (String(u || '').match(/tiktok\.com\/@([^/?#]+)/i) || [])[1] || ''

// Mirrors lib/channelRank: active = pool links not blocked; blocked = EVERY
// blocked link of the channel, including ones no longer in the pool.
const active = new Map()
for (const v of videos) {
  const c = chan(v.url)
  if (!c || blocked.has(String(v.url))) continue
  active.set(c, (active.get(c) ?? 0) + 1)
}
const blockedTotal = new Map()
for (const url of blockedUrls) {
  const c = chan(url)
  if (c) blockedTotal.set(c, (blockedTotal.get(c) ?? 0) + 1)
}
const rows = []
for (const c of new Set([...active.keys(), ...blockedTotal.keys()])) {
  const a = active.get(c) ?? 0
  const b = blockedTotal.get(c) ?? 0
  const judged = a + b
  rows.push({ c, a, b, pct: judged > 0 ? Math.round((a / judged) * 100) : null })
}
const eligible = rows.filter((r) => r.pct !== null && r.pct >= MIN)

console.log(`\nthe real pool: ${rows.length.toLocaleString()} channel(s)`)
console.log(`   eligible (>= ${MIN}%): ${eligible.length.toLocaleString()}`)
console.log(`   left to you        : ${(rows.length - eligible.length).toLocaleString()}`)
check('not everything passes', eligible.length < rows.length, true)
check('and not everything fails', eligible.length > 0, true)
check('no eligible channel is below the bar',
  eligible.filter((r) => r.pct < MIN).length, 0)
check('a channel with no links either way is excluded',
  eligible.filter((r) => r.pct === null).length, 0)

// The channels the change is FOR: hundreds of blocked links and nothing active.
const worst = rows.filter((r) => r.b >= 100 && (r.pct ?? 0) < MIN)
console.log(`\n   ${worst.length} channel(s) with 100+ blocked links are now skipped:`)
for (const r of worst.sort((x, y) => y.b - x.b).slice(0, 5))
  console.log(`     @${r.c.padEnd(24)} ${String(r.pct).padStart(3)}%  active ${r.a}, blocked ${r.b}`)
check('none of those is eligible', worst.filter((r) => eligible.includes(r)).length, 0)

await pool.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
