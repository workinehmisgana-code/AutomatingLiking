// Is "fewest of our comments per click" measuring the CHANNEL, or measuring us?
//
// The ratio is our product comments found on a channel's videos over the clicks
// workers spent opening them. Four things stand between that and a number that
// only describes our own record-keeping, and each one is checked here against
// the live pool — with the size of the difference, not just a yes:
//
//   1. a link nobody has scanned is not a link with no comments;
//   2. a scan taken BEFORE the last click cannot have seen that click's comment;
//   3. a scan that could read nothing is not an absence;
//   4. a ratio over a handful of clicks is not a ratio.
//
// And two things about who is in the table at all: Instagram links name nobody
// in their URL, so the channel has to come from the stored author; and comment
// extraction only reads TikTok, so the other two sites have no data rather than
// a score of zero.
//
// --live also reads one real channel's comments through TikTok's endpoint, the
// way the panel's "Read every comment" button does. Off by default: it is a live
// dependency, and a throttled afternoon is not a broken feature.
//
//   node scripts/check-comment-yield.mjs
//   node scripts/check-comment-yield.mjs --live
import { readFileSync, existsSync, writeFileSync } from 'node:fs'

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

// ── the live pool ───────────────────────────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

// The same shape lib/db.ts getClickScanByUrl returns, including the epoch
// milliseconds — the check would not catch a Date-stringifying mistake if it
// fetched the columns differently from the code it is checking.
const links = (
  await q(`
  SELECT c.url,
         c.n,
         (EXTRACT(EPOCH FROM c.last_click) * 1000)::bigint AS last_click,
         s.our_count,
         (EXTRACT(EPOCH FROM s.scanned_at) * 1000)::bigint AS scanned_at,
         s.read_count,
         s.complete
    FROM (SELECT url, COUNT(*)::int AS n, MAX(clicked_at) AS last_click
            FROM clicked_link GROUP BY url) c
    LEFT JOIN link_comment_scan s ON s.url = c.url`)
).map((r) => ({
  url: r.url,
  clicks: r.n,
  lastClick: Number(r.last_click),
  ourCount: r.our_count,
  scannedAt: r.scanned_at === null ? null : Number(r.scanned_at),
  readCount: r.read_count,
  complete: r.complete === true,
}))
const scansByPlatform = (
  await q(`SELECT COUNT(*) FILTER (WHERE url ILIKE '%tiktok.com%')::int    AS tiktok,
                  COUNT(*) FILTER (WHERE url ILIKE '%instagram.com%')::int AS instagram,
                  COUNT(*) FILTER (WHERE url ILIKE '%youtube.com%'
                                      OR url ILIKE '%youtu.be%')::int      AS youtube
             FROM link_comment_scan`)
)[0]
await db.end()

// videos.json, for the authors Instagram URLs do not carry. Cached so a rerun
// does not pull 45 MB again.
const CACHE = `${process.env.TEMP || '/tmp'}/videos-cache.json`
let videos
if (existsSync(CACHE)) {
  videos = JSON.parse(readFileSync(CACHE, 'utf8'))
} else {
  const { list } = await import('@vercel/blob')
  const { blobs } = await list({ prefix: 'videos.json' })
  const res = await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
  })
  videos = await res.json()
  writeFileSync(CACHE, JSON.stringify(videos))
}

// lib/channelRank.ts handleOf + channelOfRow + siteOf, in the same order.
const handleOf = (u) => {
  const tt = u.match(/tiktok\.com\/@([A-Za-z0-9._]+)\/(?:video|photo)\/\d+/i)
  if (tt) return tt[1].toLowerCase()
  const yt = u.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
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

const authors = new Map()
for (const v of videos) {
  const url = String(v?.url ?? '')
  const a = channelOfRow(url, v?.author)
  if (url && a) authors.set(url, a)
}
const keyOf = (url) => {
  const h = authors.get(url) ?? channelOfRow(url, null)
  return h ? `${siteOf(url)}:${h}` : null
}

const scanned = links.filter((l) => l.scannedAt !== null && l.ourCount !== null)
const afterClick = scanned.filter((l) => l.scannedAt >= l.lastClick)
const stale = scanned.filter((l) => l.scannedAt < l.lastClick)
const never = links.filter((l) => l.scannedAt === null || l.ourCount === null)
// lib/commentPresence's `judgeable`, applied to OUR comment instead of a user's:
// a hit is conclusive even on a partial read, a miss only when the whole list
// was readable.
const judgeable = (l) => l.ourCount > 0 || (l.readCount > 0 && l.complete)
const fresh = afterClick.filter(judgeable)
const unreadable = afterClick.filter((l) => !judgeable(l))

console.log('what the ratio is taken from:')
check('  clicked links', links.length > 0, true)
check(
  '  they account for themselves',
  fresh.length + unreadable.length + stale.length + never.length,
  links.length
)
console.log(
  `   (${links.length.toLocaleString()} clicked: ${fresh.length.toLocaleString()} counted, ` +
    `${unreadable.length.toLocaleString()} scanned but unreadable, ` +
    `${stale.length.toLocaleString()} scanned before the last click, ${never.length.toLocaleString()} never scanned)`
)

// ── rule 1: "nobody looked" is not "nothing found" ──────────────────────────
const roll = (set) => {
  const acc = new Map()
  for (const l of set) {
    const k = keyOf(l.url)
    if (!k) continue
    const a = acc.get(k) ?? { clicks: 0, ours: 0, links: 0 }
    a.clicks += l.clicks
    a.ours += l.ourCount ?? 0
    a.links++
    acc.set(k, a)
  }
  return acc
}
const honest = roll(fresh)
// The mistake being guarded against: counting an unscanned link as a zero.
const naive = roll([...fresh, ...never.map((l) => ({ ...l, ourCount: 0 }))])

const MIN = 25
const rank = (acc) =>
  [...acc]
    .filter(([, a]) => a.clicks >= MIN)
    .sort(([ka, a], [kb, b]) => a.ours / a.clicks - b.ours / b.clicks || b.clicks - a.clicks || ka.localeCompare(kb))
const honestTop = rank(honest).slice(0, 20).map(([k]) => k)
const naiveTop = rank(naive).slice(0, 20).map(([k]) => k)
const invented = naiveTop.filter((k) => !honestTop.includes(k))

console.log('\nan unscanned link is not a link with no comments:')
check('  there are unscanned clicked links to get this wrong about', never.length > 0, true)
check(
  '  counting them as zero would rewrite the worst-20',
  invented.length > 0,
  true
)
console.log(`   (${invented.length} of the worst 20 would be channels nobody has scanned, not channels with no comments)`)
check('  so only scanned links are rolled up', /const scanned = l\.scannedAt !== null/.test(read('lib/commentYield.ts')), true)
check(
  '  and the unscanned ones are counted, not silently dropped',
  /basis\.unscanned\+\+/.test(read('lib/commentYield.ts')),
  true
)

// ── rule 2: a scan must postdate the click it is judging ────────────────────
console.log('\na scan older than the last click cannot have seen that click’s comment:')
check('  the pool contains such links', stale.length > 0, true)
const staleZero = stale.filter((l) => (l.ourCount ?? 0) === 0).length
console.log(`   (${stale.length} link(s), ${staleZero} of them reading zero — each one a free accusation)`)
check('  they are excluded', /const fresh = scanned && \(l\.scannedAt as number\) >= l\.lastClick/.test(read('lib/commentYield.ts')), true)
check('  and reported as stale rather than as zero', /basis\.stale\+\+/.test(read('lib/commentYield.ts')), true)
// The comparison is arithmetic on epoch milliseconds. A Date stringifies to
// "Wed Sep 17 …", which orders by weekday, so this is not a style point.
check('  the two instants are numbers from Postgres', /EXTRACT\(EPOCH FROM c\.last_click\) \* 1000/.test(read('lib/db.ts')), true)
check('  both of them', /EXTRACT\(EPOCH FROM s\.scanned_at\) \* 1000/.test(read('lib/db.ts')), true)
check('  neither is stringified anywhere (a Date sorts by weekday)',
      !/String\(r\.last_click\)|String\(r\.scanned_at\)/.test(read('lib/db.ts')), true)

// ── rule 3: a scan that read nothing is not an absence ─────────────────────
console.log('\na video we could not read is not a video with no comment on it:')
check('  such scans exist', unreadable.length > 0, true)
const readNothing = unreadable.filter((l) => (l.readCount ?? 0) === 0).length
console.log(
  `   (${unreadable.length} link(s) left out: ${readNothing} where the scan read NO comments at all, ` +
    `${unreadable.length - readNothing} where the read was cut short with none of ours found)`
)
// The size of the mistake: how many channels would read a flat zero if these
// counted, against how many actually do.
const zeroIf = rank(roll([...fresh, ...unreadable])).filter(([, a]) => a.ours === 0).length
const zeroNow = rank(roll(fresh)).filter(([, a]) => a.ours === 0).length
check('  counting them would invent channels at zero', zeroIf > zeroNow, true)
console.log(`   (${zeroIf} channel(s) would read a flat zero; ${zeroNow} actually do)`)
check(
  '  a hit counts even on a partial read, a miss only on a complete one',
  /\(l\.ourCount \?\? 0\) > 0 \|\| \(\(l\.readCount \?\? 0\) > 0 && l\.complete\)/.test(read('lib/commentYield.ts')),
  true
)
check(
  '  which is lib/commentPresence’s rule',
  /judgeable: found \|\| \(!read\.unresolved && read\.complete\)/.test(read('lib/commentPresence.ts')),
  true
)
check('  and they are counted, not dropped in silence', /basis\.unreadable\+\+/.test(read('lib/commentYield.ts')), true)
check('  the panel shows the bucket', /nothing readable on the page/.test(read('components/AdminLinks.tsx')), true)

// ── rule 4: a floor, or the table is a list of one-click channels ───────────
console.log('\na ratio over a handful of clicks is not a ratio:')
const all = [...honest].filter(([, a]) => a.links > 0)
const below = all.filter(([, a]) => a.clicks < MIN)
const zeroBelow = below.filter(([, a]) => a.ours === 0).length
check('  channels with comment data at all', all.length > 0, true)
console.log(
  `   (${all.length} channel(s); ${below.length} below ${MIN} clicks, ${zeroBelow} of those sitting at a "perfect" zero)`
)
check('  the floor keeps them out', /if \(a\.clicks < minClicks\)/.test(read('lib/commentYield.ts')), true)
check('  and says how many it kept out', /basis\.channelsBelowFloor\+\+/.test(read('lib/commentYield.ts')), true)
// An empty box must mean the default, not 0 — the harshest possible setting
// reached by clearing a field to retype it.
const route = read('app/api/admin/links/comment-yield/route.ts')
check('  the route clamps what it is given', /Math\.max\(1, Math\.min\(1000, Math\.round\(raw\)\)\)/.test(route), true)
check('  an unreadable value is the default, not zero', /Number\.isFinite\(raw\) \? .* : 25/.test(route), true)
const ui = read('components/AdminLinks.tsx')
check('  and an empty box is too', /raw === '' \|\| !Number\.isFinite\(Number\(raw\)\) \? 25/.test(ui), true)

// ── who is in the table ────────────────────────────────────────────────────
console.log('\nevery counted link can be attributed to a channel:')
const unattributed = {}
for (const l of fresh) if (!keyOf(l.url)) unattributed[siteOf(l.url)] = (unattributed[siteOf(l.url)] ?? 0) + 1
check('  none left over', unattributed, {})
// Instagram URLs are /p/<code>/ and name nobody. Without the stored author the
// whole site vanishes from the table — the failure that hid @betweenstudybreaks.
const urlOnly = {}
for (const l of fresh) {
  if (!channelOfRow(l.url, null)) urlOnly[siteOf(l.url)] = (urlOnly[siteOf(l.url)] ?? 0) + 1
}
const igPool = videos.filter((v) => String(v?.url ?? '').includes('instagram.com'))
// Today the counted set is entirely TikTok, whose URLs carry the handle, so the
// author map changes nothing yet. It is what stops the table losing all of
// Instagram the day Instagram comments can be read — the same map, and the same
// failure, as the one that hid @betweenstudybreaks from the channel list.
console.log(
  `   (URL alone would lose ${JSON.stringify(urlOnly)} of the counted set, which is all TikTok today; ` +
    `${igPool.filter((v) => authors.has(v.url)).length.toLocaleString()} of ${igPool.length.toLocaleString()} Instagram links carry the stored author it will need)`
)
check(
  '  the pool’s own answer is used first',
  /const r = poolRow\.get\(url\)\s*\n\s*if \(r\?\.channel\) return r\.channel/.test(read('lib/commentYield.ts')),
  true
)
check(
  '  with the URL only as a fallback for links no longer in the pool',
  /Links a worker opened that are no longer in the pool/.test(read('lib/commentYield.ts')),
  true
)
// Same handle on two sites is two channels — 98 of ours exist on more than one.
check('  the key is site AND handle', /`\$\{platform\}:\$\{handle\}`/.test(read('lib/commentYield.ts')), true)

console.log('\nthe table is one platform wide, and says so:')
check('  TikTok scans', scansByPlatform.tiktok > 0, true)
check('  Instagram scans', scansByPlatform.instagram, 0)
check('  YouTube scans', scansByPlatform.youtube, 0)
console.log('   (comment extraction reads TikTok’s comment endpoint and nothing else)')
check('  the panel says which sites have no data', /TikTok only\. Comment extraction has read/.test(ui), true)
check('  and that their absence is not a zero', /have no comment data and are absent from this table/.test(ui), true)

// ── the ordering ───────────────────────────────────────────────────────────
console.log('\nworst first, and among equals the one that has cost the most:')
const ranked = rank(honest)
check(
  '  the ratio never increases down the list',
  ranked.every(([, a], i) => i === 0 || ranked[i - 1][1].ours / ranked[i - 1][1].clicks <= a.ours / a.clicks),
  true
)
const tiedFirst = ranked.filter(([, a]) => a.ours === 0)
check('  channels at a flat zero exist', tiedFirst.length > 0, true)
check(
  '  and they are ordered by clicks spent, most first',
  tiedFirst.every(([, a], i) => i === 0 || tiedFirst[i - 1][1].clicks >= a.clicks),
  true
)
check('  which is what the sort says', /b\.clicks - a\.clicks \|\|\s*\n?\s*a\.channel\.localeCompare\(b\.channel\)/.test(read('lib/commentYield.ts')), true)
if (ranked.length) {
  const [k, a] = ranked[0]
  console.log(`   (worst: ${k} — ${a.ours} of our comments across ${a.links} links and ${a.clicks} clicks)`)
}

// ── the two cluster columns ────────────────────────────────────────────────
// Where a channel's links sit in the two ladders that decide what gets served.
// Reimplemented from lib/adminLinks assignClusters, as check-cluster-independence
// does, so the numbers below are real and not taken on trust.
const RANK_N = 30
const DATE_N = 100
function assign(list, key, n_wanted, set) {
  const s = [...list].sort((a, b) => key(a) - key(b))
  const n = Math.max(1, Math.min(n_wanted, s.length))
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((s.length - start) / (n - i))
    for (let j = start; j < start + size; j++) set(s[j], i + 1)
    start += size
  }
}
const poolRows = videos
  .filter((v) => String(v?.url ?? '').startsWith('http'))
  .map((v) => ({
    url: String(v.url),
    platform: String(v.platform ?? 'unknown'),
    rank: Number(v.search_rank ?? 0) || 0,
    dateScore: typeof v.date_score === 'number' ? v.date_score : null,
    dateOnly: Boolean(v.date_only),
    channel: channelOfRow(String(v.url), v.author) || '',
    rankCluster: 0,
    dateCluster: 0,
  }))
const anyScored = poolRows.some((r) => r.dateScore !== null)
const byPlatform = new Map()
for (const r of poolRows) {
  const l = byPlatform.get(r.platform) ?? []
  l.push(r)
  byPlatform.set(r.platform, l)
}
byPlatform.forEach((l) => {
  assign(l.filter((r) => !r.dateOnly), (r) => (r.rank > 0 ? r.rank : Number.MAX_SAFE_INTEGER),
         RANK_N, (r, c) => { r.rankCluster = c })
  assign(l, (r) => (anyScored ? (r.dateScore !== null ? -r.dateScore : Number.MAX_SAFE_INTEGER)
                              : 0),
         DATE_N, (r, c) => { r.dateCluster = c })
})

console.log('\nwhere each channel sits in the two ladders:')
const clusterAcc = new Map()
for (const r of poolRows) {
  if (!r.channel) continue
  const k = `${siteOf(r.url)}:${r.channel}`
  if (!honest.has(k)) continue
  const c = clusterAcc.get(k) ?? { rank: 0, rankN: 0, date: 0, dateN: 0 }
  if (r.rankCluster > 0) { c.rank += r.rankCluster; c.rankN++ }
  if (r.dateCluster > 0) { c.date += r.dateCluster; c.dateN++ }
  clusterAcc.set(k, c)
}
const shown = [...honest].filter(([, a]) => a.clicks >= MIN).map(([k]) => k)
const withRank = shown.filter((k) => (clusterAcc.get(k)?.rankN ?? 0) > 0)
const withDate = shown.filter((k) => (clusterAcc.get(k)?.dateN ?? 0) > 0)
// A channel every one of whose links has been blocked is gone from the pool, so
// there is nothing left to average and both columns show a dash.
check('  channels with pool links to average', withDate.length > 0, true)
console.log(
  `   (${shown.length - withDate.length} of ${shown.length} have no pool links left at all — ` +
    'every one blocked or removed — and show a dash)'
)
console.log(
  `   (${withRank.length} of ${shown.length} also have a search-rank cluster; ` +
    `the rest are date-only links, which are left out of the rank clustering entirely)`
)
// A date_only link keeps rankCluster 0 in buildAdminLinks. Zero is not a
// cluster: averaged in, it would read as better than cluster 1 and drag exactly
// the channels with no rank at all to the top of a sort by it.
const zeroRank = poolRows.filter((r) => r.rankCluster === 0).length
check('  links with no rank cluster exist to get this wrong about', zeroRank > 0, true)
console.log(`   (${zeroRank.toLocaleString()} pool link(s) carry no rank cluster)`)
const yieldSrc = read('lib/commentYield.ts')
check('  zero is read as "no place in this dimension"',
      /r\.rankCluster > 0 \? r\.rankCluster : null/.test(yieldSrc), true)
check('  and never averaged in', /if \(r\.rankCluster > 0\) \{ c\.rank \+= r\.rankCluster; c\.rankN\+\+ \}/.test(yieldSrc), true)
// One definition of a cluster, or this panel would show numbers the Links table
// could not reproduce.
check('  the clusters come from the same build the Links table uses',
      /buildAdminLinks\(''\)/.test(yieldSrc), true)
check('  averaged over the channel’s POOL links, not the scanned sample',
      /for \(const r of pool\.rows\) \{[\s\S]{0,200}?if \(!acc\.has\(key\)\) continue/.test(yieldSrc), true)
// A channel with no place in a dimension must not be sorted as if it had the
// best one — or the worst.
check('  a missing average sorts last in both directions',
      /if \(x === null\) return 1\s*\n\s*if \(y === null\) return -1/.test(ui), true)
check('  and prints as a dash, not 0.0', /avgRankCluster === null \? '—'/.test(ui), true)
check('  both columns are sortable', /\['rankCluster', 'avg rank cluster'/.test(ui) && /\['dateCluster', 'avg date cluster'/.test(ui), true)
check('  clicking a sorted column reverses it',
      /s\.col === col\s*\n?\s*\? \{ col, dir: s\.dir === 'asc' \? 'desc' : 'asc' \}/.test(ui), true)
const best = shown
  .map((k) => ({ k, c: clusterAcc.get(k) }))
  .filter((x) => x.c?.rankN)
  .sort((a, b) => a.c.rank / a.c.rankN - b.c.rank / b.c.rankN)
if (best.length) {
  const b = best[0]
  const w = best[best.length - 1]
  console.log(
    `   (best average rank cluster: ${b.k} at ${(b.c.rank / b.c.rankN).toFixed(1)}; ` +
      `worst: ${w.k} at ${(w.c.rank / w.c.rankN).toFixed(1)})`
  )
}

// ── both sides of a channel, and what is written under each link ───────────
console.log('\nopening a channel shows both sides, with the comments:')
check('  links are split by whether ours is on them',
      /\(ours > 0 \? a\.withOurs : a\.withoutOurs\)\.push\(entry\)/.test(yieldSrc), true)
const sample = rank(honest).find(([, a]) => a.ours > 0)
if (sample) {
  const [k] = sample
  const mine = fresh.filter((l) => keyOf(l.url) === k)
  console.log(
    `   (e.g. ${k}: ${mine.filter((l) => (l.ourCount ?? 0) > 0).length} link(s) carrying ours, ` +
      `${mine.filter((l) => (l.ourCount ?? 0) === 0).length} carrying none)`
  )
}
check('  both sides are rendered', /carrying our comments/.test(ui) && /carrying none of ours/.test(ui), true)
// The comment TEXT is not in the table payload. It is fetched per channel, on
// opening — the table covers every channel at once, and shipping every comment
// with it would be megabytes nobody asked for.
check('  the text is fetched when a row is opened', /comment-yield\/comments/.test(ui), true)
check('  once per link, then kept', /!\(u in yieldComments\)/.test(ui), true)
check('  our comments are shown verbatim', /o\.text \|\| <span className="text-zinc-600">\(no text\)<\/span>/.test(ui), true)
check('  with the product, position and likes', /#\{o\.rank\}/.test(ui) && /♥\{o\.likes\}/.test(ui), true)
// On a link carrying none of ours, the video's own top comment is what IS there.
check('  a barren link shows what IS on it instead', /their top/.test(ui), true)
const withTop = (
  await (async () => {
    const d = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    const r = (await d.query(
      `SELECT COUNT(*) FILTER (WHERE COALESCE(top_text,'') <> '')::int AS n, COUNT(*)::int AS all
         FROM link_comment_scan WHERE our_count = 0`
    )).rows[0]
    await d.end()
    return r
  })()
)
console.log(
  `   (${withTop.n.toLocaleString()} of ${withTop.all.toLocaleString()} scanned links with none of ours kept the video’s own top comment; ` +
    'the rest could read no comments at all, and rule 3 keeps those out of the ratio entirely)'
)
check('  a readable barren link has one to show', withTop.n > 0, true)
// A read cut off halfway is not evidence that our comment is absent.
check('  and an incomplete read says so', /the read was cut short, so an absence here is not proof/.test(ui), true)

// ── every comment on the page, not only ours ─────────────────────────
// What we WROTE DOWN is our product comments and the video's one top comment.
// Everything else on the video was read at scan time and thrown away, so showing
// "all the comments" means reading the videos again, now.
console.log('\nreading every comment is a live read, and it says so:')
const api = read('app/api/admin/links/comment-yield/comments/route.ts')
check('  the full read is opt-in, never automatic', /body\?\.full === true/.test(api), true)
check('  the button asks for it explicitly', /Read every comment/.test(ui), true)
// One request per page per link. A 40-link channel is ~160 requests, so it is
// bounded and resumable rather than one call that dies at the platform's limit.
check('  reads run several at a time', /const CONCURRENCY = 4/.test(api), true)
check('  and stop starting new ones at a deadline', /const DEADLINE_MS = 45_000/.test(api), true)
check('  at least one link always runs', /if \(live\.size > 0 && Date\.now\(\) >= deadline\) return/.test(api), true)
// A link the deadline cut off is ABSENT, not empty: empty would mean "read, and
// there is nothing there", which is the one thing this whole panel is careful
// not to say by accident.
check('  an unreached link is left out, not returned empty',
      /if \(body\?\.full === true && !live\.has\(url\)\) continue/.test(api), true)
check('  and the caller is told how many are left', /remaining: body\?\.full === true \? urls\.length - live\.size : 0/.test(api), true)
check('  which the button offers to carry on with', /Continue — \$\{left\} link/.test(ui), true)
// Ours are marked by the SAME rule the scan counted them by, or a comment could
// be in `our_count` and not highlighted where an admin reads it.
check('  our comments are marked by the scan\u2019s own rule', /productsIn\(c\.text\)/.test(api), true)
check('  which commentScan exports for exactly that', /export function productsIn/.test(read('lib/commentScan.ts')), true)
// The live list must not become the stored scan. Different depth, different
// purpose, and the whole pipeline reads link_comment_scan.
check('  nothing is written back to the scan', !/saveLinkScan|INSERT INTO link_comment_scan/.test(api), true)
check('  and the route says why', /has no business overwriting it/.test(api), true)
check('  a dead video does not take the channel with it', /A dead video must not take the rest of the channel with it/.test(api), true)

if (process.argv.includes('--live')) {
  console.log('\nthe comment endpoint, for real (nothing is written):')
  const d2 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  const sample = (
    await d2.query(`
    SELECT s.url FROM link_comment_scan s
      JOIN (SELECT url, MAX(clicked_at) lc FROM clicked_link GROUP BY url) c ON c.url = s.url
     WHERE s.scanned_at >= c.lc AND (s.our_count > 0 OR (s.read_count > 0 AND s.complete))
     ORDER BY s.scanned_at DESC LIMIT 8`)
  ).rows.map((r) => r.url)
  await d2.end()

  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  const readOne = async (url) => {
    const id = (url.match(/\/(?:video|photo)\/(\d+)/) || [])[1]
    if (!id) return { url, comments: [] }
    const res = await fetch(
      `https://www.tiktok.com/api/comment/list/?aweme_id=${id}&count=50&cursor=0&aid=1988`,
      { headers: { 'User-Agent': UA, Referer: url, 'Accept-Language': 'en-US,en;q=0.9' } }
    ).catch(() => null)
    if (!res || !res.ok) return { url, comments: [] }
    const body = await res.text()
    if (!body.trim()) return { url, comments: [] }
    const j = JSON.parse(body)
    return { url, total: j.total ?? null, comments: (j.comments ?? []).map((c) => c.text || '') }
  }
  const t0 = Date.now()
  const got = []
  let i = 0
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        const k = i++
        if (k >= sample.length) return
        got.push(await readOne(sample[k]))
      }
    })
  )
  const took = Date.now() - t0
  const withAny = got.filter((g) => g.comments.length > 0)
  console.log(
    `   ${got.length} link(s) in ${(took / 1000).toFixed(1)}s, ${withAny.length} returned comments ` +
      `— a 45s deadline fits about ${Math.round(45000 / (took / got.length))} link(s)`
  )
  check('  the endpoint still answers', withAny.length > 0, true)
  // The point of showing all of them: most comments on these videos are nothing
  // to do with us, and that is exactly what an admin cannot see today.
  const all = withAny.flatMap((g) => g.comments)
  const ourNames = ['purifytext', 'acoustictext', 'prohumanly', 'humlexic', 'tintfolio', 'kinprose']
  const mine = all.filter((t) => ourNames.some((n) => t.toLowerCase().replace(/[^a-z0-9]/g, '').includes(n)))
  console.log(`   ${all.length} comment(s) read, ${mine.length} of them ours`)
  check('  and most of what is there is not ours', all.length > mine.length, true)
}

// ── the click count is the same one the rest of the page uses ──────────────
console.log('\nour own test clicks are not counted as work that produced nothing:')
const dbSrc = read('lib/db.ts')
const yieldQuery = dbSrc.split('export async function getClickScanByUrl')[1].split('export async function')[0]
check('  admin accounts are excluded', /CLICK_EXCLUDED_EMAILS/.test(yieldQuery), true)
check('  exactly as getClickCountsByUrl excludes them',
      /lower\(email\) = ANY\(\$1::text\[\]\)/.test(yieldQuery), true)

// ── the panel does not turn a measurement into a verdict ────────────────────
console.log('\nthe number is a place to look, not a conviction:')
check('  the basis is shown before the table', /clicked links in all/.test(ui), true)
check('  each channel shows counted / clicked links', /links counted/.test(ui), true)
check(
  '  both sides of a channel can be opened and checked',
  /carrying our comments/.test(ui) && /most-clicked first/.test(ui),
  true
)
check('  and the panel says what a zero does not mean', /It does not\s*\n?\s*say why/.test(ui), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
