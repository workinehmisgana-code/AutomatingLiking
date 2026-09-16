// Fill in the missing Instagram channel for links we already hold.
//
// TikTok and YouTube put the handle in the URL. Instagram does not — a post is
// /p/<code>/ and names nobody — so an Instagram link only has a channel if the
// scrape stored one beside it. 4,151 of ours did not, and those links belong to
// no channel anywhere in the dashboard: not in the ranked list, not in a channel
// search, not in the channel-activity ratio.
//
// THE OWNER IS READABLE. The post's own embed carries it, in the profile link
// and again in the username element:
//
//   https://www.instagram.com/p/<code>/embed/   ->  instagram.com/<handle>/?utm
//
// Measured on 20 real unattributed links: every LIVE post resolved (14 of 14),
// at ~1.1s each. The other 6 returned a fixed-size 226,679-byte shell with no
// media id and no profile link — that is what a deleted or private post serves,
// so they are reported as gone rather than as failures.
//
// (1_tiktok_search_scraper/instagram_owner.py resolves owners too, from the
// POST PAGE, at 85%. It never tried the plain embed. This is the better route
// and costs one request.)
//
// SAFE TO RE-RUN. It only looks at rows whose author is still blank, and writes
// the blob once at the end after verifying that nothing but `author` changed.
//
//   node scripts/backfill-instagram-authors.mjs --dry-run
//   node scripts/backfill-instagram-authors.mjs --limit 500
//   node scripts/backfill-instagram-authors.mjs            # all of them
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const LIMIT = (() => {
  const i = args.indexOf('--limit')
  const n = i >= 0 ? Number(args[i + 1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : Infinity
})()
/** Embeds in flight. Instagram tolerates this; higher starts returning 429. */
const CONCURRENCY = 6

const SHORTCODE = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|tv)\/([A-Za-z0-9_-]+)/i
// Two independent signals; either is enough, and needing only one is why this
// resolves every live post rather than most of them.
const OWNER_PATTERNS = [
  /instagram\.com\/([A-Za-z0-9._]{1,30})\/\?utm/,
  /class="[^"]*UsernameText[^"]*"[^>]*>([A-Za-z0-9._]{1,30})</,
]
// Handles the embed chrome uses for its own links, never a real owner.
const NOT_A_HANDLE = new Set(['p', 'reel', 'tv', 'explore', 'accounts', 'about', 'developer'])

function ownerOf(html) {
  for (const re of OWNER_PATTERNS) {
    const m = re.exec(html)
    const h = m?.[1]?.toLowerCase()
    if (h && !NOT_A_HANDLE.has(h)) return h
  }
  return null
}

async function resolve(url) {
  const code = SHORTCODE.exec(url)?.[1]
  if (!code) return { state: 'no-code' }
  try {
    const res = await fetch(`https://www.instagram.com/p/${code}/embed/`, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1' },
    })
    if (!res.ok) return { state: 'http', detail: res.status }
    const html = await res.text()
    const owner = ownerOf(html)
    if (owner) return { state: 'ok', owner }
    // No owner AND no media id is the deleted-post shell, not a parse failure.
    return { state: /"media_id"\s*:\s*"?\d/.test(html) ? 'unparsed' : 'gone' }
  } catch (e) {
    return { state: 'error', detail: String(e).slice(0, 60) }
  }
}

const { list, put } = await import('@vercel/blob')
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
  console.log('could not read videos.json')
  process.exit(1)
}

const targets = pool.filter(
  (v) => v?.url?.includes('instagram.com') && !String(v.author ?? '').trim()
)
const todo = targets.slice(0, LIMIT === Infinity ? targets.length : LIMIT)
console.log(`${pool.length.toLocaleString()} link(s) in the pool`)
console.log(`${targets.length.toLocaleString()} instagram link(s) with no author`)
console.log(`resolving ${todo.length.toLocaleString()}${DRY ? ' (dry run — nothing will be written)' : ''}\n`)

const counts = { ok: 0, gone: 0, unparsed: 0, http: 0, error: 0, 'no-code': 0 }
const found = new Map() // url -> handle
let done = 0
const started = Date.now()

let next = 0
const worker = async () => {
  for (;;) {
    const i = next++
    if (i >= todo.length) return
    const v = todo[i]
    const r = await resolve(String(v.url))
    counts[r.state] = (counts[r.state] ?? 0) + 1
    if (r.state === 'ok') found.set(String(v.url), r.owner)
    done++
    if (done % 100 === 0 || done === todo.length) {
      const rate = done / ((Date.now() - started) / 1000)
      const left = Math.round((todo.length - done) / Math.max(rate, 0.01) / 60)
      process.stdout.write(
        `  ${done}/${todo.length} · ${found.size} resolved · ${counts.gone} gone · ` +
          `${rate.toFixed(1)}/s · ~${left} min left\n`
      )
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

console.log('\nresults:')
for (const [k, n] of Object.entries(counts))
  if (n) console.log(`   ${k.padEnd(10)} ${n.toLocaleString()}`)
const channels = new Set(found.values())
console.log(`\n${found.size.toLocaleString()} link(s) resolved, across ${channels.size.toLocaleString()} channel(s)`)
console.log('   e.g.', [...channels].slice(0, 8).join(', '))

if (DRY) {
  console.log('\ndry run — nothing written.')
  process.exit(0)
}
if (found.size === 0) {
  console.log('\nnothing to write.')
  process.exit(0)
}

// Write `author` and NOTHING else. Verified field by field before the upload:
// this blob is the whole link pool, and a script that quietly changed something
// else would be discovered much later.
const after = pool.map((v) => {
  const owner = v?.url ? found.get(String(v.url)) : undefined
  return owner ? { ...v, author: owner } : v
})
let changed = 0
for (let i = 0; i < pool.length; i++) {
  const a = pool[i]
  const b = after[i]
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const k of keys) {
    if (JSON.stringify(a?.[k]) === JSON.stringify(b?.[k])) continue
    if (k !== 'author') throw new Error(`row ${i}: ${k} changed, which this script must not touch`)
    changed++
  }
}
if (changed !== found.size) throw new Error(`expected ${found.size} changes, found ${changed}`)
console.log(`\nverified: ${changed.toLocaleString()} author field(s) changed and nothing else`)

await put('videos.json', JSON.stringify(after), {
  access: 'public',
  addRandomSuffix: false,
  contentType: 'application/json',
})
console.log('written. Re-run "Rank channels" to see the new channels.')
