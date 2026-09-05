// How big is the hourly pipeline actually being asked to do?
//
// "Extract comments for all search-rank clustered links and the top 3 posted-date
// clusters" is a link count, and reading one video's comments costs seconds. This
// turns the request into hours so the schedule can be set against reality.
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const res = await fetch(blobs[0].url, {
  headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
})
const videos = await res.json()

const isTikTok = (v) => /tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i.test(String(v.url || ''))
const tiktok = videos.filter(isTikTok)
// The rank dimension excludes date_only links (merged from the verify list).
const rankable = tiktok.filter((v) => !v.date_only)
const dateOnly = tiktok.length - rankable.length

// Cluster counts come from lib/config: rank 30, date 100.
const RANK_CLUSTERS = 30
const DATE_CLUSTERS = 100
const perDateCluster = Math.floor(tiktok.length / DATE_CLUSTERS)

console.log(`pool                       : ${videos.length.toLocaleString()}`)
console.log(`  TikTok links             : ${tiktok.length.toLocaleString()}`)
console.log(`  of those, rank-clustered : ${rankable.length.toLocaleString()}  (${dateOnly.toLocaleString()} are date-only)`)
console.log()
console.log(`ALL ${RANK_CLUSTERS} rank clusters      = ${rankable.length.toLocaleString()} links`)
console.log(`top 3 of ${DATE_CLUSTERS} date clusters = ${(perDateCluster * 3).toLocaleString()} links`)

// Measured rate: the scan route runs 4 comment reads at a time and gets through
// roughly 40 links per 45-second request.
const PER_HOUR = Math.round((40 / 45) * 3600)
const target = rankable.length + perDateCluster * 3
console.log(`\nreading comments manages about ${PER_HOUR.toLocaleString()} links/hour flat out`)
console.log(`one full pass over that target = ${(target / PER_HOUR).toFixed(1)} hours of continuous scanning`)
console.log(
  `\nAn hourly job has 60 minutes. It can cover ${((PER_HOUR / target) * 100).toFixed(1)}% of the target per hour.`
)
