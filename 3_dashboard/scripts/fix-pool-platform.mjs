// Correct pool rows whose `platform` contradicts their URL.
//
// lib/verifyMerge used to hard-code platform: 'tiktok', so every Instagram link
// merged from the verify list entered videos.json labelled TikTok. That decides
// which tab a link shows under, which hourly quota it counts against and which
// retirement threshold applies, so those links have been served as TikTok work.
//
// The code is fixed; this repairs what was already written.
//
// Only the platform field is touched. Nothing is added, removed or reordered,
// and the script proves that before writing: any difference other than platform
// on the listed URLs aborts the run.
//
//   node scripts/fix-pool-platform.mjs          # dry run, writes nothing
//   node scripts/fix-pool-platform.mjs --apply  # back up, then write
import { readFileSync, writeFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const APPLY = process.argv.includes('--apply')

/** Mirrors platformFromUrl in lib/config.ts. */
const platformFromUrl = (url) => {
  const u = String(url ?? '').toLowerCase()
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('youtube.com') || u.includes('youtu.be')) {
    return u.includes('/shorts/') ? 'youtube_shorts' : 'youtube_videos'
  }
  return 'tiktok'
}

const { list, put } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
if (!blobs.length) {
  console.log('no videos.json in blob storage — nothing to do')
  process.exit(1)
}
const before = await (await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  cache: 'no-store',
})).text()
const videos = JSON.parse(before)
console.log(`pool: ${videos.length.toLocaleString()} link(s), ${(before.length / 1048576).toFixed(1)} MB`)

const wrong = []
for (const v of videos) {
  const want = platformFromUrl(String(v.url ?? ''))
  if (String(v.platform ?? '') !== want) wrong.push({ v, from: String(v.platform ?? ''), to: want })
}
if (wrong.length === 0) {
  console.log('every row already agrees with its URL — nothing to correct')
  process.exit(0)
}

const tally = {}
for (const w of wrong) {
  const k = `"${w.from}" -> "${w.to}"`
  tally[k] = (tally[k] ?? 0) + 1
}
console.log(`\n${wrong.length.toLocaleString()} row(s) to correct:`)
for (const [k, n] of Object.entries(tally)) console.log(`   ${k}: ${n.toLocaleString()}`)

// How many are in circulation right now, so the effect is stated rather than
// guessed at: a corrected link moves tab for every user who still has it.
const blocked = new Set()
try {
  const { Pool } = await import('pg')
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  for (const r of (await db.query('SELECT url FROM blocked_link')).rows) blocked.add(r.url)
  const urls = wrong.map((w) => String(w.v.url))
  const clicks = await db.query(
    'SELECT COUNT(*)::int n, COUNT(DISTINCT user_id)::int u FROM clicked_link WHERE url = ANY($1::text[])',
    [urls]
  )
  console.log(`   ${clicks.rows[0].n.toLocaleString()} click(s) by ${clicks.rows[0].u} user(s) on these links so far`)
  await db.end()
} catch (e) {
  console.log('   (could not read the database for context:', String(e).slice(0, 60) + ')')
}
console.log(`   ${wrong.filter((w) => blocked.has(String(w.v.url))).length} of them are blocked (corrected anyway — a block can be lifted)`)
console.log('\n   e.g.')
for (const w of wrong.slice(0, 4)) console.log(`     ${String(w.v.url).slice(0, 58)}  ${w.from} -> ${w.to}`)

if (!APPLY) {
  console.log('\nDRY RUN — nothing was written. Re-run with --apply to write.')
  process.exit(0)
}

// ── apply ───────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backup = new URL(`../videos.backup-${stamp}.json`, import.meta.url)
writeFileSync(backup, before)
console.log(`\nbacked up the current pool to ${backup.pathname.split('/').pop()}`)

for (const w of wrong) w.v.platform = w.to

// Prove only platform moved: same rows, same order, same everything else.
const after = JSON.stringify(videos)
const a = JSON.parse(before)
const b = JSON.parse(after)
if (a.length !== b.length) throw new Error('row count changed — refusing to write')
let touched = 0
for (let i = 0; i < a.length; i++) {
  const ka = Object.keys(a[i])
  const kb = Object.keys(b[i])
  if (a[i].url !== b[i].url) throw new Error(`row ${i} changed URL — refusing to write`)
  if (ka.length !== kb.length) throw new Error(`row ${i} gained or lost a field — refusing to write`)
  for (const k of ka) {
    if (JSON.stringify(a[i][k]) === JSON.stringify(b[i][k])) continue
    if (k !== 'platform') throw new Error(`row ${i} changed "${k}" — refusing to write`)
    touched++
  }
}
if (touched !== wrong.length) throw new Error(`expected ${wrong.length} changes, found ${touched}`)
console.log(`verified: ${touched.toLocaleString()} platform field(s) changed and nothing else`)

await put('videos.json', after, {
  access: 'public',
  addRandomSuffix: false,
  contentType: 'application/json',
})
console.log('written.')
