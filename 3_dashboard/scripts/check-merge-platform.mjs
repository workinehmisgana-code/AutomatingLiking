// What platform does a merged link land in the pool as?
//
// It used to be 'tiktok', always: lib/verifyMerge hard-coded it, and verify_link
// never wrote its own platform column so the DEFAULT 'tiktok' covered every row.
// Platform is not cosmetic — it decides which tab a link shows under, which
// hourly quota it counts against, and which retirement threshold applies.
//
// This reads the real verify list and the real pool and reports what the fixed
// rule produces, plus what is already stored wrong.
//
//   node scripts/check-merge-platform.mjs
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

/** Mirrors platformFromUrl in lib/config.ts. */
const platformFromUrl = (url) => {
  const u = String(url ?? '').toLowerCase()
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('youtube.com') || u.includes('youtu.be')) {
    return u.includes('/shorts/') ? 'youtube_shorts' : 'youtube_videos'
  }
  return 'tiktok'
}

const tally = (xs, f) => {
  const o = {}
  for (const x of xs) o[f(x)] = (o[f(x)] ?? 0) + 1
  return o
}

const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

console.log('the verify list, waiting to be merged:')
const verify = (await db.query('SELECT url, platform FROM verify_link')).rows
console.log(`   ${verify.length.toLocaleString()} link(s) staged`)
console.log('   stored platform column says:', tally(verify, (r) => r.platform))
console.log('   their URLs say:             ', tally(verify, (r) => platformFromUrl(r.url)))
const wrongCol = verify.filter((r) => r.platform !== platformFromUrl(r.url))
console.log(`   ${wrongCol.length.toLocaleString()} row(s) have a platform column that contradicts their URL`)

console.log('\nwhat a merge writes into the pool now:')
check(
  'no staged link would be labelled tiktok unless it is one',
  verify.filter((r) => platformFromUrl(r.url) === 'tiktok' && !r.url.includes('tiktok.com')).length,
  0
)
check(
  'every instagram URL is labelled instagram',
  verify.filter((r) => r.url.includes('instagram.com') && platformFromUrl(r.url) !== 'instagram').length,
  0
)

console.log('\nthe pool as it stands:')
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }, cache: 'no-store',
})).json()
const bad = videos.filter((v) => String(v.platform ?? '') !== platformFromUrl(String(v.url ?? '')))
console.log(`   ${videos.length.toLocaleString()} link(s); ${bad.length.toLocaleString()} carry a platform that contradicts their URL`)
if (bad.length) {
  console.log('   they are:', tally(bad, (v) => `${platformFromUrl(String(v.url))} url labelled "${v.platform}"`))
  console.log('   e.g.', String(bad[0].url).slice(0, 60))
  console.log('   (already merged before the fix — run this again after a backfill)')
}

// Spot-check the rule itself on shapes that actually occur.
console.log('\nthe rule on each shape:')
for (const [url, want] of [
  ['https://www.instagram.com/p/Dcwh928SBNs/', 'instagram'],
  ['https://www.instagram.com/reel/Dcwh928SBNs/', 'instagram'],
  ['https://www.tiktok.com/@a/video/7440781326799686930', 'tiktok'],
  ['https://www.tiktok.com/@a/photo/7654294593567034644', 'tiktok'],
  ['https://www.youtube.com/shorts/abc123', 'youtube_shorts'],
  ['https://www.youtube.com/watch?v=abc123', 'youtube_videos'],
  ['https://youtu.be/abc123', 'youtube_videos'],
]) {
  check(`  ${url.slice(0, 46)}`, platformFromUrl(url), want)
}

await db.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
