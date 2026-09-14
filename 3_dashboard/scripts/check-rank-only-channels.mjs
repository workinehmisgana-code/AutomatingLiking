// Which channels rank for a keyword but have nothing carrying a date score?
//
// The comparison is between CHANNELS, over the whole pool. It rests on one
// definition that has to be right, because the obvious alternative has no
// answer: a channel is on the DATE side when one of its links carries a date
// SCORE, not merely when it has a date cluster. Every link is given a date
// cluster whether scored or not — the unscored ones sort to the bottom and land
// in the last bucket because everything must land somewhere — so counting
// buckets would put every ranked channel on both sides and always return zero.
//
// Mirrors the route against the real pool.
//
//   node scripts/check-rank-only-channels.mjs
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

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const videos = await (await fetch(blobs[0].url, { headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }, cache: 'no-store' })).json()

const channelOf = (u) => (String(u || '').match(/tiktok\.com\/@([^/?#]+)/i) || [])[1] || ''
const poolAll = videos.filter((v) => String(v.platform) === 'tiktok')
// Filled in below, once blocked_link has been read.
let pool = poolAll

const { Pool } = await import('pg')
const dbPool0 = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const blockedSet = new Set((await dbPool0.query('SELECT url FROM blocked_link')).rows.map((r) => r.url))
const titles = new Map()
for (const r of (await dbPool0.query('SELECT url, title FROM link_title')).rows) if (r.title) titles.set(r.url, r.title)
await dbPool0.end()

// Cluster assignment, as lib/adminLinks does it.
const assign = (rows, key, n) => {
  const s = [...rows].sort((a, b) => key(a) - key(b))
  const out = new Map()
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((s.length - start) / (n - i))
    for (let j = start; j < start + size; j++) out.set(s[j].url, i + 1)
    start += size
  }
  return out
}
const rankCl = assign(poolAll.filter((v) => !v.date_only && Number(v.search_rank) > 0),
  (v) => v.search_rank, 30)
const dateCl = assign(poolAll, (v) => -(typeof v.date_score === 'number' ? v.date_score : -Infinity), 50)
// The route filters AFTER buildAdminLinks rather than re-clustering a subset,
// so a link keeps the cluster number the table shows it in.
pool = poolAll.filter((v) => !blockedSet.has(v.url))
console.log(`pool: ${poolAll.length.toLocaleString()} link(s), ${pool.length.toLocaleString()} of them not blocked`)

const rankOnly = (wanted, byBucketOnly = false) => {
  const inRank = (v) => (rankCl.get(v.url) ?? 0) > 0 && (!wanted || wanted.has(rankCl.get(v.url)))
  const inDate = (v) =>
    (byBucketOnly || typeof v.date_score === 'number') &&
    (dateCl.get(v.url) ?? 0) > 0 &&
    (!wanted || wanted.has(dateCl.get(v.url)))
  const dateCh = new Set(pool.filter(inDate).map((v) => channelOf(v.url)).filter(Boolean))
  const out = new Set()
  for (const v of pool) {
    if (!inRank(v)) continue
    const c = channelOf(v.url)
    if (c && !dateCh.has(c)) out.add(c)
  }
  return { channels: out, rankLinks: pool.filter(inRank).length, dateLinks: pool.filter(inDate).length }
}

console.log('counting buckets — the definition that does NOT work:')
const byBucket = rankOnly(null, true)
check('every ranked channel looks present, so the answer is always zero', byBucket.channels.size, 0)

console.log('')
console.log('counting SCORES — the definition the route uses:')
const whole = rankOnly(null, false)
console.log(`   ${whole.rankLinks.toLocaleString()} ranked link(s), ${whole.dateLinks.toLocaleString()} scored link(s)`)
check('over the whole pool, no live channel ranks without a scored link', whole.channels.size, 0)
const withBlocked = (() => {
  const keep = pool
  pool = poolAll
  const r = rankOnly(null, false)
  pool = keep
  return r
})()
console.log(`   put the blocked links back and it is ${withBlocked.channels.size} channel(s) — all of them blocked work`)
check('so excluding blocked is what makes the whole-pool answer honest', withBlocked.channels.size > 0, true)

console.log('\nnarrowed to a selection, it has an answer:')
for (const top of [1, 3, 5, 10]) {
  const wanted = new Set(Array.from({ length: top }, (_, i) => i + 1))
  const r = rankOnly(wanted)
  console.log(
    `   cluster(s) 1-${top}: ${r.rankLinks.toLocaleString()} rank link(s), ` +
      `${r.dateLinks.toLocaleString()} date link(s) -> ${r.channels.size} rank-only channel(s)`
  )
  check(`  1-${top} finds some`, r.channels.size > 0, true)
}
const three = rankOnly(new Set([1, 2, 3]))
console.log('   e.g.', Array.from(three.channels).slice(0, 6).map((c) => '@' + c).join(', '))
// The point of the list: these channels are worth re-scraping. So none of them
// may already be on the date side of the same selection.
const dateCh3 = new Set(
  pool.filter((v) => [1, 2, 3].includes(dateCl.get(v.url) ?? 0)).map((v) => channelOf(v.url)).filter(Boolean)
)
check('none of them is on the date side after all',
  Array.from(three.channels).filter((c) => dateCh3.has(c)).length, 0)


// ── the keyword that found each channel ─────────────────────────────────────
// The list is only actionable if it says WHICH search turned the channel up:
// re-scraping means running that keyword again, and a channel found by three
// keywords is a different proposition from one found by a single stray hit.
const keywordsFor = (rows) => {
  const per = new Map()
  for (const v of rows) {
    const c = channelOf(v.url)
    const kw = String(v.search_query ?? '').trim()
    if (!c || !kw) continue
    const m = per.get(c) ?? new Map()
    const r = Number(v.search_rank) > 0 ? Number(v.search_rank) : Number.MAX_SAFE_INTEGER
    if (!m.has(kw) || r < m.get(kw)) m.set(kw, r)
    per.set(c, m)
  }
  return per
}

console.log('')
console.log('the keyword that found each channel:')
const all = three // the whole-pool set is empty by design; judge on clusters 1-3
const kwMap = keywordsFor(pool.filter((v) => (rankCl.get(v.url) ?? 0) > 0))
const sampleChannels = Array.from(all.channels).slice(0, 6)
for (const c of sampleChannels) {
  const m = kwMap.get(c)
  const listed = m
    ? Array.from(m.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([k, r]) => `${k} (#${r})`)
    : []
  console.log(`   @${c.padEnd(22)} ${listed.slice(0, 3).join(' · ') || '(none recorded)'}`)
}
check(
  'every rank-only channel names at least one keyword',
  Array.from(all.channels).filter((c) => !kwMap.has(c)).length,
  0
)
check(
  'and they come back best-ranked first',
  (() => {
    const ranks = Array.from(kwMap.get(sampleChannels[0]).values()).sort((a, b) => a - b)
    return ranks.every((r, i) => i === 0 || r >= ranks[i - 1])
  })(),
  true
)
const spread = {}
for (const c of all.channels) {
  const n = kwMap.get(c)?.size ?? 0
  spread[n] = (spread[n] ?? 0) + 1
}
console.log('   channels by how many keywords found them:')
for (const k of Object.keys(spread).map(Number).sort((a, b) => a - b))
  console.log(`     ${k} keyword(s): ${spread[k]}`)


// ── the videos listed under each channel row ────────────────────────────────
// The row is only judgeable if the titles are actually there, so measure how
// many of these links carry one rather than assuming. The cap has to keep the
// BEST-ranked links, not the first fifty the pool happens to hold.
const MAX_VIDEOS_PER_CHANNEL = 50
const videosFor = (chans) => {
  const per = new Map()
  for (const v of pool) {
    if ((rankCl.get(v.url) ?? 0) <= 0) continue
    const c = channelOf(v.url)
    if (!c || !chans.has(c)) continue
    const list = per.get(c) ?? []
    list.push({
      url: v.url,
      title: String(titles.get(v.url) ?? ''),
      rank: Number(v.search_rank) || 0,
      cluster: rankCl.get(v.url) ?? 0,
      keyword: String(v.search_query ?? '').trim(),
      blocked: blockedSet.has(v.url),
    })
    per.set(c, list)
  }
  for (const [c, list] of per) {
    list.sort((a, b) => (a.rank || Number.MAX_SAFE_INTEGER) - (b.rank || Number.MAX_SAFE_INTEGER))
    per.set(c, list.slice(0, MAX_VIDEOS_PER_CHANNEL))
  }
  return per
}

console.log('')
console.log('the flat per-video rows the modal lists:')
const vidMap = videosFor(all.channels)
check('every rank-only channel lists at least one video', Array.from(all.channels).filter((c) => !(vidMap.get(c)?.length > 0)).length, 0)

let shown = 0
let titled = 0
let blocked = 0
for (const list of vidMap.values()) {
  for (const v of list) {
    shown++
    if (v.title.trim()) titled++
    if (v.blocked) blocked++
  }
}
console.log(`   ${shown.toLocaleString()} video row(s) across ${vidMap.size} channel(s)`)
console.log(`   ${titled.toLocaleString()} carry a title (${Math.round((titled / shown) * 100)}%) — the rest fall back to the URL`)
console.log(`   ${blocked.toLocaleString()} are already blocked — which is WHY these channels have no date score`)

const flat = Array.from(vidMap.values()).flat()
check('every row carries a title for the classifier to read', flat.filter((v) => !v.title.trim()).length, 0)
check('every row carries a cluster', flat.filter((v) => !(v.cluster > 0)).length, 0)
console.log(`   ${flat.filter((v) => v.keyword).length.toLocaleString()} of ${flat.length.toLocaleString()} name the keyword that found them`)
// Hiding blocked rows is a toggle, and it defaults OFF for this reason: on the
// live pool it hides every single row and the modal looks broken.
const stillOpen = flat.filter((v) => !v.blocked)
console.log(`   ${stillOpen.length.toLocaleString()} row(s) are still blockable; "hide already-blocked" would leave ${stillOpen.length}`)
console.log(`   the classifier runs in ${Math.ceil(stillOpen.length / 100)} batch(es) of 100`)

check(
  'no listed video exceeds the cap',
  Array.from(vidMap.values()).filter((l) => l.length > MAX_VIDEOS_PER_CHANNEL).length,
  0
)
check(
  'each list is best-ranked first, unranked last',
  Array.from(vidMap.values()).filter((l) =>
    l.some((v, i) => i > 0 && (v.rank || Infinity) < (l[i - 1].rank || Infinity))
  ).length,
  0
)

// The cap is only honest if what it drops is worse than what it keeps.
const biggest = Array.from(vidMap.entries()).sort((a, b) => b[1].length - a[1].length)[0]
const allOfBiggest = pool.filter(
  (v) => channelOf(v.url) === biggest[0] && (rankCl.get(v.url) ?? 0) > 0
)
console.log(`   biggest row: @${biggest[0]} has ${allOfBiggest.length} ranked link(s), ${biggest[1].length} listed`)
if (allOfBiggest.length > MAX_VIDEOS_PER_CHANNEL) {
  const kept = new Set(biggest[1].map((v) => v.url))
  const worstKept = Math.max(...biggest[1].map((v) => v.rank || Infinity))
  const bestDropped = Math.min(
    ...allOfBiggest.filter((v) => !kept.has(v.url)).map((v) => Number(v.search_rank) || Infinity)
  )
  check('the cap keeps the best-ranked, drops the worst', worstKept <= bestDropped, true)
}


console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
