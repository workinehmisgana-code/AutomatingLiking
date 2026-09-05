// Read-only: do outliers distort the posted-date clustering?
//
// Most of the pipeline is rank-based and therefore immune: percentiles ignore
// magnitude, and clusters are equal-COUNT chunks of a sorted list, so one viral
// video cannot stretch a bucket.
//
// One step is not. A channel's heart signal is its MEAN like count, and a mean is
// exactly what a single viral video breaks — every other link on that channel
// then inherits the inflated figure and rides it into a top cluster. The
// percentile downstream ranks channels against each other, which cannot undo a
// number that was already wrong before it got there.
//
// This measures how far the mean and the median actually diverge, and how many
// links move as a result.
//
//   node scripts/check-outliers.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
if (!blobs.length) {
  console.log('videos.json not found in blob storage')
  process.exit(1)
}
const res = await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
})
const videos = await res.json()
console.log(`pool: ${videos.length.toLocaleString()} links\n`)

const channelOf = (u) => {
  const m = String(u || '').match(/tiktok\.com\/@([A-Za-z0-9._]+)\//i)
  return m ? m[1].toLowerCase() : null
}
const heartsOf = (v) => {
  const h = Number(v.heart_count)
  if (Number.isFinite(h) && h > 0) return h
  const l = Number(v.like_count)
  return Number.isFinite(l) && l > 0 ? l : null
}

const byChannel = new Map()
for (const v of videos) {
  const ch = channelOf(v.url)
  const h = heartsOf(v)
  if (!ch || h === null) continue
  if (!byChannel.has(ch)) byChannel.set(ch, [])
  byChannel.get(ch).push(h)
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

let skewed = 0
let counted = 0
const worst = []
for (const [ch, hs] of byChannel) {
  if (hs.length < 3) continue
  counted++
  const mean = hs.reduce((a, b) => a + b, 0) / hs.length
  const med = median(hs)
  const ratio = med > 0 ? mean / med : Infinity
  if (ratio >= 2) skewed++
  worst.push({ ch, n: hs.length, mean, med, ratio, max: Math.max(...hs) })
}
worst.sort((a, b) => b.ratio - a.ratio)

console.log(`channels with 3+ known counts : ${counted.toLocaleString()}`)
console.log(`  whose MEAN is >=2x their MEDIAN : ${skewed.toLocaleString()} (${((100 * skewed) / counted).toFixed(1)}%)`)
console.log('\nthe worst offenders — one video dragging a whole channel up:\n')
console.log(`   ${'channel'.padEnd(22)} ${'links'.padStart(5)} ${'median'.padStart(9)} ${'mean'.padStart(11)} ${'biggest'.padStart(11)}`)
for (const w of worst.slice(0, 12)) {
  console.log(
    `   ${w.ch.slice(0, 22).padEnd(22)} ${String(w.n).padStart(5)} ${Math.round(w.med).toLocaleString().padStart(9)} ` +
      `${Math.round(w.mean).toLocaleString().padStart(11)} ${w.max.toLocaleString().padStart(11)}`
  )
}

// How many LINKS ride an inflated channel average?
let affected = 0
for (const w of worst) if (w.ratio >= 2) affected += w.n
console.log(
  `\n${affected.toLocaleString()} links belong to a channel whose mean is at least twice its median.`
)

// Does swapping mean for median actually move things? Compare the percentile
// rank of each channel under both.
const pct = (vals) => {
  const s = [...vals].sort((a, b) => a - b)
  const m = new Map()
  for (let i = 0; i < s.length; ) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[i]) j++
    m.set(s[i], s.length > 1 ? (i + j) / 2 / (s.length - 1) : 1)
    i = j + 1
  }
  return m
}
const chans = worst.map((w) => w.ch)
const meanPct = pct(worst.map((w) => w.mean))
const medPct = pct(worst.map((w) => w.med))
let moved = 0
let bigMove = 0
for (const w of worst) {
  const a = meanPct.get(w.mean) ?? 0
  const b = medPct.get(w.med) ?? 0
  if (Math.abs(a - b) > 0.05) moved++
  if (Math.abs(a - b) > 0.2) bigMove++
}
console.log(
  `\nswapping the mean for the median moves ${moved} of ${chans.length} channels ` +
    `more than 5 percentile points, and ${bigMove} more than 20.`
)
