// "Cluster by: Search rank" shows search-rank links only.
//
// Links merged from the verify list carry no search rank, so assignClusters
// leaves them out of the rank dimension: rankCluster 0, no position, a row of
// dashes. They were 96% of the list and drowned out the ranked links the tab is
// about. Rank mode now excludes them; Posted date and Combined still hold every
// one of them.
//
// Two halves, because the numbers and the rule live in different places:
//
//   1. the RULE — read straight out of lib/adminLinks.ts, so removing the guard
//      fails this check instead of silently passing a mirror of it;
//   2. the NUMBERS — the real pool, clustered the way buildAdminLinks clusters
//      it, to say what each tab now shows.
//
//   node scripts/check-rank-tab.mjs
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

// ── 1. the rule is in the filter, not just in this script ──────────────────
const src = readFileSync(new URL('../lib/adminLinks.ts', import.meta.url), 'utf8')
const filterBody = src.slice(src.indexOf('export function filterAdminLinks'))
console.log('the filter itself carries the rule:')
check(
  '  rank mode drops date-only links',
  /if \(clusterBy === 'rank' && l\.date_only\) return false/.test(filterBody),
  true
)
check(
  '  and nothing else does',
  (src.match(/clusterBy === 'rank' && l\.date_only/g) ?? []).length,
  1
)
check('  counts report how many that is', /dateOnly: number/.test(src), true)

// ── 2. what that means for the real pool ───────────────────────────────────
// Same chunking as lib/cluster.ts: equal counts, per platform, date-only links
// excluded from the rank dimension only.
const RANK_CLUSTER_COUNT = 30
function assignClusters(list, key, set, n) {
  const s = [...list].sort((a, b) => key(a) - key(b))
  let start = 0
  for (let i = 0; i < n; i++) {
    const size = Math.floor((s.length - start) / (n - i))
    for (let j = start; j < start + size; j++) set(s[j], i + 1, j - start + 1)
    start += size
  }
}

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const pool = await (
  await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  })
).json()

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const blocked = new Set((await db.query('SELECT url FROM blocked_link')).rows.map((r) => r.url))
await db.end()

// The list hides blocked links unless "Blocked only" is on — so does this.
const active = pool
  .filter((v) => v?.url && !blocked.has(v.url))
  .map((v) => ({
    url: v.url,
    platform: String(v.platform ?? ''),
    date_only: Boolean(v.date_only),
    search_rank: Number(v.search_rank ?? 0),
    rankCluster: 0,
    rankPos: 0,
  }))

const byPlatform = new Map()
for (const l of active) {
  if (!byPlatform.has(l.platform)) byPlatform.set(l.platform, [])
  byPlatform.get(l.platform).push(l)
}
byPlatform.forEach((rows) =>
  assignClusters(
    rows.filter((l) => !l.date_only),
    (l) => l.search_rank,
    (l, c, pos) => { l.rankCluster = c; l.rankPos = pos },
    RANK_CLUSTER_COUNT
  )
)

const rankTab = active.filter((l) => !l.date_only) // what rank mode now returns
const hidden = active.filter((l) => l.date_only) // what it holds back

console.log('\nrank mode shows search-rank links only:')
check('  no date-only link survives', rankTab.filter((l) => l.date_only).length, 0)
check('  every row has a rank cluster', rankTab.filter((l) => !(l.rankCluster >= 1)).length, 0)
check('  none past the last cluster', rankTab.filter((l) => l.rankCluster > RANK_CLUSTER_COUNT).length, 0)
check('  every row has a position', rankTab.filter((l) => !(l.rankPos >= 1)).length, 0)

console.log('\nthe rows it drops are exactly the ones that showed a dash:')
check('  all of them lack a rank cluster', hidden.filter((l) => l.rankCluster !== 0).length, 0)

console.log('\nnothing was lost — the other two tabs still hold everything:')
check('  shown + hidden = the whole active pool', rankTab.length + hidden.length, active.length)

console.log(
  `\nrank tab: ${rankTab.length.toLocaleString()} links, ` +
    `down from ${active.length.toLocaleString()} · ` +
    `${hidden.length.toLocaleString()} moved out of sight`
)
const perPlat = {}
for (const l of rankTab) perPlat[l.platform] = (perPlat[l.platform] ?? 0) + 1
for (const [p, n] of Object.entries(perPlat).sort((a, b) => b[1] - a[1]))
  console.log(`   ${p.padEnd(16)} ${n.toLocaleString()}  (~${Math.round(n / RANK_CLUSTER_COUNT)} per cluster)`)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
