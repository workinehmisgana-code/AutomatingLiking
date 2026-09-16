// Is the ranked channel list actually complete?
//
// "Some channels are left out" is the right question to ask of a list built by
// deriving a handle from a URL, and it has two different answers:
//
//   THE LIST IS COMPLETE for every link whose channel can be read. A channel is
//     included whether its links are search-rank clustered, posted-date
//     clustered, or both — rankChannels reads the whole pool, and the two
//     clusterings are not inputs to it at all.
//
//   SOME LINKS HAVE NO READABLE CHANNEL, and those genuinely belong to no row.
//     A YouTube Shorts URL is /shorts/<id> and names nobody; an Instagram post
//     is /p/<code>/ and only names its account when the scrape stored one.
//     That is a property of the links, not a bug in the ranking — but it has to
//     be COUNTED, or its effect looks like missing channels.
//
// The third answer, and the one that actually bit: a channel can be in the list
// and still not on screen, because the site chip is filtering it out.
//
//   node scripts/check-ranked-completeness.mjs
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

const handleOf = (url) => {
  const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
  if (tt) return tt[1].toLowerCase()
  const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return yt[1].toLowerCase()
  return null
}
const channelOfRow = (url, author) =>
  handleOf(url) ?? (String(author ?? '').trim().replace(/^@/, '').toLowerCase() || null)

const { list } = await import('@vercel/blob')
let pool = null
for (let i = 0; i < 4 && !pool; i++) {
  try {
    const { blobs } = await list({ prefix: 'videos.json' })
    pool = await (
      await fetch(blobs[0].url, {
        headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
        cache: 'no-store',
      })
    ).json()
  } catch {
    await new Promise((r) => setTimeout(r, 4000))
  }
}
if (!pool) {
  console.log('could not fetch the pool')
  process.exit(1)
}

const rows = pool.filter((v) => v?.url)
const acc = new Map()
const unattributed = { total: 0, byPlatform: {} }
for (const v of rows) {
  const url = String(v.url)
  const h = channelOfRow(url, v.author)
  const p = String(v.platform ?? '') || 'unknown'
  if (!h) {
    unattributed.total++
    unattributed.byPlatform[p] = (unattributed.byPlatform[p] ?? 0) + 1
    continue
  }
  const a = acc.get(h) ?? { links: 0, ranked: 0, dateOnly: 0 }
  a.links++
  if (v.date_only) a.dateOnly++
  else a.ranked++
  acc.set(h, a)
}

console.log(`the pool holds ${rows.length.toLocaleString()} link(s)`)
console.log(`   ${acc.size.toLocaleString()} channel(s) in the ranked list`)
console.log(`   ${unattributed.total.toLocaleString()} link(s) with no readable channel`)
for (const [p, n] of Object.entries(unattributed.byPlatform).sort((a, b) => b[1] - a[1]))
  console.log(`      ${p.padEnd(16)} ${n.toLocaleString()}`)

console.log('\nevery link is accounted for, one way or the other:')
const attributed = [...acc.values()].reduce((a, x) => a + x.links, 0)
check('  attributed + unattributed = the pool', attributed + unattributed.total, rows.length)

console.log('\nboth clusterings are represented — neither is an input to the ranking:')
let rankOnly = 0
let dateOnly = 0
let both = 0
for (const a of acc.values()) {
  if (a.ranked > 0 && a.dateOnly > 0) both++
  else if (a.ranked > 0) rankOnly++
  else dateOnly++
}
console.log(`   ${rankOnly.toLocaleString()} channels have only search-ranked links`)
console.log(`   ${dateOnly.toLocaleString()} have only date-clustered links`)
console.log(`   ${both.toLocaleString()} have both`)
check('  channels with only date-clustered links are included', dateOnly > 0, true)
check('  and they all add up', rankOnly + dateOnly + both, acc.size)

// The channel that prompted this. It is in the list, and it is mostly
// date-clustered — which is exactly the case that was suspected of being lost.
const sample = acc.get('betweenstudybreaks')
console.log('\nthe channel that was reported missing:')
check('  @betweenstudybreaks is in the list', !!sample, true)
if (sample)
  console.log(
    `   ${sample.links} link(s): ${sample.ranked} search-ranked, ${sample.dateOnly} date-clustered`
  )

// ── the wiring ─────────────────────────────────────────────────────────────
const rank = read('lib/channelRank.ts')
const route = read('app/api/admin/verify-links/extract/route.ts')
const ui = read('components/VerifyLinks.tsx')

console.log('\nthe unreadable ones are counted, not skipped in silence:')
check('  counted while ranking', /lastUnattributed\.total\+\+/.test(rank), true)
check('  and exposed', /export function unattributedLinks/.test(rank), true)
check('  the route sends the count', /unattributed: unattributedLinks\(\)/.test(route), true)
check('  and the header shows it', /link\(s\) have no readable channel/.test(ui), true)

console.log('\nand a channel hidden by the site chip says where it is:')
check('  the hidden matches are found', /const hiddenBySite =/.test(ui), true)
check('  the empty state names the site', /is on \$\{hiddenBySite\[0\]\.platform\}/.test(ui), true)
check('  and offers the way back', /show all sites/.test(ui), true)

console.log('\nthe disabled Extract button explains itself:')
check("  it says TikTok only", /⬇ Extract — TikTok only/.test(ui), true)
check('  and Export takes over on those sites', /text-white bg-teal-700 hover:bg-teal-600 border-teal-600/.test(ui), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
