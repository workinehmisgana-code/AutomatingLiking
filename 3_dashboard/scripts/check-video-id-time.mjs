// Read-only: can a TikTok video id be trusted to order a channel's videos by time?
//
// "Extract new videos" should take only what a channel posted AFTER the newest
// video we already hold for it. That needs a recency comparison, and the only
// value present on every listing entry is the id — the listing carries no date.
// TikTok ids are said to hold the creation time in their top 32 bits. This checks
// that against dates actually scraped, rather than taking it on faith.
//
//   node scripts/check-video-id-time.mjs [path/to/scraped.csv]
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Seconds since the epoch encoded in a TikTok video id, or null. */
export function idTime(id) {
  try {
    const n = BigInt(id)
    if (n <= 0n) return null
    const secs = Number(n >> 32n)
    // TikTok launched in 2016, and nothing is posted in the future.
    if (secs < 1451606400 || secs * 1000 > Date.now() + 86_400_000) return null
    return secs
  } catch {
    return null
  }
}

/** "5d ago", "3 weeks ago", "2026-08-14" -> epoch ms, against the scrape time. */
function parsePosted(raw, scrapedAt) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return null
  const base = Date.parse(scrapedAt || '') || Date.now()
  if (s === 'just now' || s === 'today') return base
  if (s === 'yesterday') return base - 86_400_000
  const unit = {
    second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5,
    month: 26298e5, year: 315576e5,
    s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 26298e5, y: 315576e5,
  }
  let m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/)
  if (m) return base - Number(m[1]) * unit[m[2]]
  m = s.match(/^(\d+)\s*(mo|s|m|h|d|w|y)\s*ago$/)
  if (m) return base - Number(m[1]) * unit[m[2]]
  // "8-16" is month-day, not a year. Date.parse reads it as 2001-08-16 and the
  // comparison then looks 25 years out — which is a bug in this reader, not in
  // the ids. lib/cluster.ts resolves it against the scrape date; so does this.
  let md = s.match(/^(\d{1,2})[-/](\d{1,2})$/)
  if (md) {
    const y = new Date(base).getUTCFullYear()
    let t = Date.UTC(y, +md[1] - 1, +md[2])
    if (t > base + 86_400_000) t = Date.UTC(y - 1, +md[1] - 1, +md[2])
    return t
  }
  const ymd = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (ymd) return Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3])
  const abs = Date.parse(raw)
  return Number.isNaN(abs) ? null : abs
}

/** Minimal CSV split that survives quoted fields with commas. */
function splitRow(line) {
  const out = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

const dir = new URL('../../1_tiktok_search_scraper/results/', import.meta.url).pathname.replace(/^\//, '')
const file =
  process.argv[2] ||
  readdirSync(dir)
    .filter((f) => f.endsWith('.csv'))
    .map((f) => join(dir, f))
    .sort()
    .pop()

const text = readFileSync(file, 'utf8')
const lines = text.split(/\r?\n/).filter(Boolean)
const head = splitRow(lines[0])
const iUrl = head.indexOf('url')
const iPosted = head.indexOf('posted_date')
const iScraped = head.indexOf('scraped_at')
console.log(`${file.split(/[\\/]/).pop()}: ${lines.length - 1} rows\n`)

let usable = 0
let within2d = 0
let within7d = 0
let worst = 0
const samples = []
const pairs = []
const buckets = []

for (let i = 1; i < lines.length; i++) {
  const row = splitRow(lines[i])
  const url = row[iUrl]
  const m = String(url || '').match(/\/(?:video|photo)\/(\d+)/)
  if (!m) continue
  const secs = idTime(m[1])
  const posted = parsePosted(row[iPosted], row[iScraped])
  if (secs === null || posted === null) continue
  usable++
  const diffDays = Math.abs(secs * 1000 - posted) / 86_400_000
  if (diffDays <= 2) within2d++
  if (diffDays <= 7) within7d++
  if (diffDays > worst) worst = diffDays
  // Which unit the scrape recorded, and whether it pins the day.
  const raw = String(row[iPosted] || '').trim().toLowerCase()
  const unit = /\d+\s*(second|minute|hour|s|m|h)\s*ago/.test(raw)
    ? 'hours'
    : /\d+\s*(day|d|week|w)s?\s*ago/.test(raw)
      ? 'days/weeks'
      : /\d+\s*(month|mo|year|y)s?\s*ago/.test(raw)
        ? 'months/years'
        : /^\d/.test(raw)
          ? 'absolute'
          : 'other'
  // 'absolute' is excluded: TikTok writes "8-16" for a video from ANY year and
  // this reader has to guess the year, so a wrong guess here would be blamed on
  // the id. The relative rows date themselves unambiguously.
  const dayPrecise = unit === 'hours' || unit === 'days/weeks'
  buckets.push({ unit, diff: diffDays })
  pairs.push([BigInt(m[1]), posted, dayPrecise])
  if (samples.length < 5) {
    samples.push(
      `   id ${m[1]} -> ${new Date(secs * 1000).toISOString().slice(0, 10)}   ` +
        `scraped as "${row[iPosted]}" = ${new Date(posted).toISOString().slice(0, 10)}   ` +
        `off ${diffDays.toFixed(1)}d`
    )
  }
}

console.log(`comparable rows          : ${usable}`)
if (usable) {
  console.log(`id date within 2 days    : ${within2d} (${((100 * within2d) / usable).toFixed(1)}%)`)
  console.log(`id date within 7 days    : ${within7d} (${((100 * within7d) / usable).toFixed(1)}%)`)
  console.log(`worst disagreement       : ${worst.toFixed(1)} days`)
  console.log('\nsamples:')
  samples.forEach((s) => console.log(s))
}

// Where the disagreements actually come from. "3 months ago" is recorded as
// base minus 90 days whatever day it really was, so a wide gap there says the
// SCRAPED string is coarse, not that the id is wrong. Only the fine-grained
// rows can test the id at all.
console.log('\ndisagreement by how precise the scraped date was:')
const byUnit = new Map()
for (const b of buckets) {
  const g = byUnit.get(b.unit) || { n: 0, ok2: 0, sum: 0 }
  g.n++
  if (b.diff <= 2) g.ok2++
  g.sum += b.diff
  byUnit.set(b.unit, g)
}
for (const [unit, g] of [...byUnit.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(
    `   ${unit.padEnd(12)} ${String(g.n).padStart(5)} rows  ` +
      `${((100 * g.ok2) / g.n).toFixed(0).padStart(3)}% within 2 days  ` +
      `mean gap ${(g.sum / g.n).toFixed(1)}d`
  )
}

// ORDER is what matters, not absolute accuracy: does a larger id always mean a
// later post? Tested only on rows dated to the day, since a coarser row cannot
// contradict anything meaningfully.
const fine = pairs.filter((p) => p[2])
fine.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
let inversions = 0
for (let i = 1; i < fine.length; i++) {
  if (fine[i][1] < fine[i - 1][1] - 2 * 86_400_000) inversions++
}
console.log(
  `\nordering on day-precise rows: ${fine.length - 1 - inversions} of ` +
    `${Math.max(fine.length - 1, 0)} consecutive pairs agree ` +
    `(${inversions} contradict by more than 2 days)`
)

// ── the property the extractor actually relies on ───────────────────────────
// Per CHANNEL, is the largest id also the most recently posted video? That is
// the high-water mark: everything at or below it has been seen, everything above
// it is new. If this held only in general and not per channel, the mark would
// let old videos through or hide new ones.
const byChannel = new Map()
for (let i = 1; i < lines.length; i++) {
  const row = splitRow(lines[i])
  const url = String(row[iUrl] || '')
  const m = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)\/(?:video|photo)\/(\d+)/i)
  if (!m) continue
  const posted = parsePosted(row[iPosted], row[iScraped])
  const raw = String(row[iPosted] || '').trim().toLowerCase()
  // Only rows that date themselves unambiguously, as above.
  if (!/\d+\s*(second|minute|hour|day|week|s|m|h|d|w)s?\s*ago/.test(raw)) continue
  if (posted === null || idTime(m[2]) === null) continue
  const h = m[1].toLowerCase()
  if (!byChannel.has(h)) byChannel.set(h, [])
  byChannel.get(h).push({ id: BigInt(m[2]), posted })
}

let channels = 0
let agree = 0
const wrong = []
for (const [h, vids] of byChannel) {
  if (vids.length < 3) continue
  channels++
  const byId = [...vids].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0]
  const byDate = [...vids].sort((a, b) => b.posted - a.posted)[0]
  // Same day counts as agreement: the scraped date has day resolution at best.
  if (Math.abs(byId.posted - byDate.posted) <= 2 * 86_400_000) agree++
  else wrong.push(`   @${h}: newest by id is ${Math.round((byDate.posted - byId.posted) / 86400000)}d older than newest by date (${vids.length} videos)`)
}
console.log(`
per channel (>=3 dated videos): ${agree} of ${channels} agree on which video is newest`)
wrong.slice(0, 5).forEach((w) => console.log(w))
