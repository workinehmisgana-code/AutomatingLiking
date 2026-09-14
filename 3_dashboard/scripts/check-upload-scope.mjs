// Can an upload still reach a posted-date link?
//
// It must not. A link with no search rank belongs to the posted-date clusters
// alone — it came from the verify list, not a keyword search — and 121,110 of
// the 130,184 stored links are in that state. Before this rule a single
// `upload.py --replace` of a TikTok CSV deleted 93% of the pool, silently,
// because the replace was scoped by PLATFORM and every one of those links is
// tiktok.
//
// So this checks the two things that could put them back in reach:
//   * replace dropping them because they are not in the batch
//   * append rewriting one because the batch happens to contain its URL
//
// The route's logic is mirrored here rather than imported (it is a Next.js
// module with server-only imports), and then run against the REAL pool's shape
// as well as against the small cases that are easy to reason about.
//
//   node scripts/check-upload-scope.mjs
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

// ── mirrors app/api/upload/route.ts ─────────────────────────────────────────
const platformOf = (v) => String(v.platform ?? 'unknown')
const urlKey = (v) => String(v.url ?? '').trim().split('?')[0].replace(/\/+$/, '')
const dateClusteredOnly = (v) => v.date_only === true || !(Number(v.search_rank) > 0)
const dedupeByUrl = (rows) => {
  const m = new Map()
  for (const v of rows) {
    const k = urlKey(v)
    if (k && !m.has(k)) m.set(k, v)
  }
  return [...m.values()]
}
const refreshLink = (stored, incoming) => {
  let changed = false
  const nl = Number(incoming.like_count)
  if (Number.isFinite(nl) && nl > 0 && nl !== Number(stored.like_count)) {
    stored.like_count = nl
    changed = true
  }
  const nr = Number(incoming.search_rank)
  if (Number.isFinite(nr) && nr > 0 && nr !== Number(stored.search_rank)) {
    stored.search_rank = nr
    changed = true
  }
  return changed
}

function applyReplace(existing, incoming) {
  const incomingPlatforms = new Set(incoming.map(platformOf))
  const kept = existing.filter(
    (v) => !incomingPlatforms.has(platformOf(v)) || dateClusteredOnly(v)
  )
  const protectedDateOnly = existing.filter(
    (v) => incomingPlatforms.has(platformOf(v)) && dateClusteredOnly(v)
  ).length
  const storedForPlatforms = new Map()
  for (const v of existing) {
    const k = urlKey(v)
    if (k && incomingPlatforms.has(platformOf(v)) && !dateClusteredOnly(v)) {
      storedForPlatforms.set(k, v)
    }
  }
  const protectedUrls = new Set(
    existing.filter(dateClusteredOnly).map(urlKey).filter(Boolean)
  )
  const byUrl = new Map()
  let reused = 0
  let added = 0
  let updated = 0
  for (const v of incoming) {
    const k = urlKey(v)
    if (!k || byUrl.has(k) || protectedUrls.has(k)) continue
    const stored = storedForPlatforms.get(k)
    if (stored) {
      if (refreshLink(stored, v)) updated++
      byUrl.set(k, stored)
      reused++
    } else {
      byUrl.set(k, v)
      added++
    }
  }
  return {
    videos: dedupeByUrl([...kept, ...byUrl.values()]),
    removed: storedForPlatforms.size - reused,
    added,
    updated,
    protectedDateOnly,
  }
}

function applyAppend(existing, incoming) {
  const byUrl = new Map()
  for (const v of existing) {
    const k = urlKey(v)
    if (k) byUrl.set(k, v)
  }
  let added = 0
  let updated = 0
  let protectedDateOnly = 0
  for (const v of incoming) {
    const k = urlKey(v)
    if (!k) continue
    const stored = byUrl.get(k)
    if (!stored) {
      byUrl.set(k, v)
      added++
    } else if (dateClusteredOnly(stored)) {
      protectedDateOnly++
    } else if (refreshLink(stored, v)) {
      updated++
    }
  }
  return { videos: [...byUrl.values()], added, updated, protectedDateOnly }
}

// ── the small cases ─────────────────────────────────────────────────────────
const L = (url, extra = {}) => ({ url, platform: 'tiktok', ...extra })
const EXISTING = [
  L('https://t/1', { search_rank: 3, like_count: 10 }), // rank link, in the batch
  L('https://t/2', { search_rank: 7, like_count: 20 }), // rank link, NOT in the batch
  L('https://t/3', { search_rank: 0, date_only: true, like_count: 30, date_score: 0.9 }),
  L('https://t/4', { date_only: true, like_count: 40 }), // flagged, no rank field at all
  L('https://y/1', { platform: 'youtube_shorts', search_rank: 1 }), // other platform
]
const INCOMING = [
  L('https://t/1', { search_rank: 2, like_count: 11 }), // same link, better rank
  L('https://t/9', { search_rank: 5, like_count: 50 }), // brand new
]

console.log('replace, with a TikTok batch:')
let r = applyReplace(structuredClone(EXISTING), structuredClone(INCOMING))
const urls = r.videos.map((v) => v.url).sort()
check('the posted-date links survive', urls.includes('https://t/3') && urls.includes('https://t/4'), true)
check('the rank link not in the batch is dropped', urls.includes('https://t/2'), false)
check('the other platform is untouched', urls.includes('https://y/1'), true)
check('the new link is added', urls.includes('https://t/9'), true)
check('removed counts only rank links', r.removed, 1)
check('and reports what it protected', r.protectedDateOnly, 2)
check('a protected link keeps its score', r.videos.find((v) => v.url === 'https://t/3').date_score, 0.9)

// The dangerous case: the batch contains a URL that is stored as date-only.
console.log('\nreplace, where the batch re-scrapes a posted-date link:')
r = applyReplace(structuredClone(EXISTING), [
  ...structuredClone(INCOMING),
  L('https://t/3', { search_rank: 4, like_count: 999 }),
])
const t3 = r.videos.find((v) => v.url === 'https://t/3')
check('it is still there', !!t3, true)
check('it did NOT gain a search rank', Number(t3.search_rank) > 0, false)
check('its like count was not rewritten', t3.like_count, 30)
check('it is stored once, not twice', r.videos.filter((v) => v.url === 'https://t/3').length, 1)

console.log('\nappend:')
r = applyAppend(structuredClone(EXISTING), [
  ...structuredClone(INCOMING),
  L('https://t/3', { search_rank: 4, like_count: 999 }),
])
check('nothing is ever dropped', r.videos.length, 6)
check('the rank link is refreshed', r.updated, 1)
check('the posted-date link is left alone', r.protectedDateOnly, 1)
check('with its like count intact',
  r.videos.find((v) => v.url === 'https://t/3').like_count, 30)

// ── the real pool ───────────────────────────────────────────────────────────
const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const pool = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }, cache: 'no-store',
  })
).json()

const dateOnly = pool.filter(dateClusteredOnly).length
console.log(
  `\nthe real pool: ${pool.length.toLocaleString()} link(s), ` +
    `${dateOnly.toLocaleString()} of them posted-date only`
)

// A replace of a plausible TikTok batch: the 200 best-ranked links it holds.
//
// Built with the SAME predicate the route protects on, not merely "has a rank".
// 723 stored links carry both a search rank and the date_only flag, and 40 of
// them are in the top 200 — cluster.ts excludes a date_only link from the rank
// clusters whatever its rank, so those are posted-date links and the route
// rightly refuses to touch them. A batch that includes them is not a
// search-rank scrape.
const batch = pool
  .filter((v) => v.platform === 'tiktok' && !dateClusteredOnly(v))
  .sort((a, b) => a.search_rank - b.search_rank)
  .slice(0, 200)
  .map((v) => ({ ...v }))
const out = applyReplace(pool.map((v) => ({ ...v })), batch)
console.log(
  `   a --replace of ${batch.length} TikTok links leaves ` +
    `${out.videos.length.toLocaleString()} stored (was ${pool.length.toLocaleString()}), ` +
    `dropping ${out.removed.toLocaleString()}`
)
const survivors = new Set(out.videos.map(urlKey))
const lostDateOnly = pool.filter((v) => dateClusteredOnly(v) && !survivors.has(urlKey(v))).length
check('not one posted-date link was lost', lostDateOnly, 0)
check('it protected all of them', out.protectedDateOnly, dateOnly)
// What it DOES drop is exactly the rank links of that platform not in the batch.
const rankTikTok = pool.filter(
  (v) => v.platform === 'tiktok' && !dateClusteredOnly(v)
).length
check('and dropped only unlisted search-rank links', out.removed, rankTikTok - batch.length)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
