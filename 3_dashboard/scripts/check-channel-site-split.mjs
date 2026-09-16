// A handle that exists on two sites is two channels, not one.
//
// rankChannels keyed its accumulator by HANDLE ALONE, and set the platform from
// whichever URL happened to be seen last. So the same name on TikTok and
// Instagram — which 98 of our handles are — collapsed into a single row:
//
//   @betweenstudybreaks   58 instagram links + 205 tiktok links  ->  one TikTok row
//
// Two things follow, and the second is worse than the first:
//
//   * the Instagram side could not be found AT ALL. Filter to Instagram, search
//     the handle, and the answer was "no channel matches".
//   * every number on the surviving row — links, median hearts, posting rate,
//     active share — was computed across both platforms, so the score that
//     ordered it described neither of them.
//
// Keyed by site AND handle, exactly as scrape_channels.py has always done
// (account_key), both sides appear with their own numbers.
//
//   node scripts/check-channel-site-split.mjs
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
const siteOf = (u) => {
  const s = u.toLowerCase()
  if (s.includes('instagram.com')) return 'instagram'
  if (s.includes('youtube.com') || s.includes('youtu.be')) return 'youtube'
  return 'tiktok'
}

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
  console.log('could not read the pool')
  process.exit(1)
}

// The old key and the new one, side by side over the real pool.
const byHandle = new Map()
const byPair = new Map()
for (const v of pool) {
  const url = String(v?.url ?? '')
  if (!url) continue
  const h = channelOfRow(url, v.author)
  if (!h) continue
  const s = siteOf(url)
  const sites = byHandle.get(h) ?? new Map()
  sites.set(s, (sites.get(s) ?? 0) + 1)
  byHandle.set(h, sites)
  const k = `${s}:${h}`
  byPair.set(k, (byPair.get(k) ?? 0) + 1)
}
const collided = [...byHandle].filter(([, sites]) => sites.size > 1)

console.log('over the live pool:')
console.log(`   ${byHandle.size.toLocaleString()} rows when keyed by handle alone`)
console.log(`   ${byPair.size.toLocaleString()} rows when keyed by site + handle`)
console.log(`   ${collided.length.toLocaleString()} handle(s) exist on more than one site`)
check('  the two keys really do differ', byPair.size > byHandle.size, true)
check('  by exactly the number of collisions', byPair.size - byHandle.size, collided.length)

console.log('\nthe reported one:')
const sites = byHandle.get('betweenstudybreaks')
check('  @betweenstudybreaks is on two sites', sites ? sites.size : 0, 2)
if (sites) {
  for (const [s, n] of sites) console.log(`   ${s.padEnd(12)} ${n} link(s)`)
  check('  and has an instagram side', (sites.get('instagram') ?? 0) > 0, true)
  check('  as well as a tiktok one', (sites.get('tiktok') ?? 0) > 0, true)
}

console.log('\na few more that were merged:')
for (const [h, s] of collided.slice(0, 5))
  console.log(`   ${h.padEnd(24)} ${[...s].map(([k, n]) => `${k} ${n}`).join(' + ')}`)

// The merged row's numbers were a blend. Show the size of the lie.
console.log('\nwhat the merge did to the numbers:')
let worst = null
for (const [h, s] of collided) {
  const total = [...s.values()].reduce((a, b) => a + b, 0)
  const biggest = Math.max(...s.values())
  const foreign = total - biggest
  if (!worst || foreign > worst.foreign) worst = { h, total, foreign, s }
}
if (worst) {
  console.log(
    `   worst case @${worst.h}: ${worst.total} links on one row, ` +
      `${worst.foreign} of them from the other platform`
  )
  check('  at least one row blended a real number of links', worst.foreign > 0, true)
}

// ── the fix, in the source ─────────────────────────────────────────────────
const rank = read('lib/channelRank.ts')
const route = read('app/api/admin/verify-links/extract/route.ts')
const ui = read('components/VerifyLinks.tsx')

console.log('\nthe accumulator is keyed by both now:')
check('  there is a key helper', /const channelKey = \(site: string, handle: string\)/.test(rank), true)
check('  the pool uses it', /const key = channelKey\(s, handle\)/.test(rank), true)
check('  the blocked list uses it too', /channelKey\(siteOf\(url\), handle\)/.test(rank), true)
check('  the site comes from the row, not a last-write map', /platform: a\.site,/.test(rank), true)
check('  and the old handle-keyed site map is gone', /const site = new Map<string, 'tiktok'/.test(rank), false)

console.log('\nand nothing downstream re-collapses them:')
check(
  '  extraction matches TikTok rows only',
  /ranked\.filter\(\(c\) => c\.platform === 'tiktok'\)\.map\(\(c\) => \[c\.handle\.toLowerCase\(\), c\]\)/.test(route),
  true
)
check('  the table keys rows by site and handle', /key=\{`\$\{c\.platform\}:\$\{c\.handle\}`\}/.test(ui), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
