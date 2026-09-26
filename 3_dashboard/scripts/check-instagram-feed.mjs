// Does the Instagram tab actually hand anybody a link?
//
// It did not. On the phone it said "No links — reopen to reload", and it was
// right about what it had been sent: zero, for every user, with 11,947 usable
// Instagram links sitting in the pool.
//
// The cause was one stale assumption, written down twice:
//
//     "Instagram links have no posted date, so they always cluster by rank."
//
// True once, when every Instagram link came off the keyword-search grid. Since
// then they arrive through scrape_channels.py and the verify list, which RECORDS
// the posted date — and marks them date_only, meaning they have no search rank.
// So the rule had inverted, and clusterAndOrder('rank') drops every date_only
// link by design.
//
// The two halves of the trap:
//
//   * every Instagram link that DOES carry a rank has been retired. Instagram
//     retires at 5 distinct users, and they have all been worked through.
//   * every Instagram link that is left is date_only, and rank-only clustering
//     cannot emit one.
//
// Zero minus zero. This measures all of that against the live pool rather than
// asserting it, because the numbers are the argument.
//
//   node scripts/check-instagram-feed.mjs
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

const cfg = read('lib/config.ts')
const IG_RETIRE = Number(cfg.match(/export const INSTAGRAM_RETIRE_AFTER_USERS = (\d+)/)?.[1])
const EXCLUDED = ['kirubelman3@gmail.com', 'misganaworkineh2011@gmail.com']

const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const q = async (s, p = []) => (await db.query(s, p)).rows

const blocked = new Set((await q('SELECT url FROM blocked_link')).map((r) => r.url))
const broken = new Set((await q('SELECT url FROM broken_link WHERE misses >= 2')).map((r) => r.url))
const counts = new Map(
  (
    await q(
      `SELECT cl.url, COUNT(*)::int n FROM clicked_link cl
        WHERE cl.user_id NOT IN (SELECT id FROM "user" WHERE lower(email) = ANY($1::text[]))
        GROUP BY cl.url`,
      [EXCLUDED]
    )
  ).map((r) => [r.url, r.n])
)

const ig = videos.filter(
  (v) => String(v?.platform ?? '') === 'instagram' && String(v?.url ?? '').startsWith('http')
)
const live = ig.filter(
  (v) => !blocked.has(v.url) && !broken.has(v.url) && (counts.get(v.url) ?? 0) < IG_RETIRE
)
const rankable = live.filter((v) => !v.date_only)

console.log('the Instagram pool, as it stands:')
check('  there are Instagram links at all', ig.length > 0, true)
console.log(
  `   ${ig.length.toLocaleString()} in the pool; ${live.length.toLocaleString()} left after blocked, ` +
    `broken and retired (Instagram retires at ${IG_RETIRE} users)`
)
// The first half of the trap: rank-only clustering can emit NONE of them.
check('  and not one of the survivors carries a search rank', rankable.length, 0)
console.log(
  `   so rank-only clustering would emit 0 of ${live.length.toLocaleString()} — which is what the ` +
    'phone was being sent'
)

// The second half: the premise was simply false.
const dated = live.filter((v) => typeof v.date_score === 'number').length
const posted = live.filter((v) => String(v?.posted_date ?? '') !== '').length
console.log('\nthe assumption behind it:')
check('  every usable Instagram link has a posted date', posted, live.length)
check('  and a composite date score', dated, live.length)
console.log('   "Instagram links have no posted date" is false for every one of them')

// Per user, which is the number that matters.
const users = await q(
  `SELECT u.id, u.email, COUNT(c.url)::int AS clicked
     FROM "user" u LEFT JOIN clicked_link c ON c.user_id = u.id
    GROUP BY u.id, u.email ORDER BY clicked DESC LIMIT 5`
)
console.log('\nwhat the busiest users would be handed:')
let worstBefore = Infinity
let worstAfter = Infinity
for (const u of users) {
  const mine = new Set((await q('SELECT url FROM clicked_link WHERE user_id = $1', [u.id])).map((r) => r.url))
  const unrel = new Set((await q('SELECT url FROM unrelated_link WHERE user_id = $1', [u.id])).map((r) => r.url))
  const free = (arr) => arr.filter((v) => !mine.has(v.url) && !unrel.has(v.url)).length
  const before = free(rankable)
  const after = free(live)
  worstBefore = Math.min(worstBefore, before)
  worstAfter = Math.min(worstAfter, after)
  console.log(`   ${String(u.email).padEnd(32)} rank-only: ${String(before).padStart(5)}   both: ${String(after).padStart(6)}`)
}
await db.end()
check('  rank-only gave every one of them nothing', worstBefore, 0)
check('  both clusterings give them all thousands', worstAfter > 1000, true)

// ── the code ───────────────────────────────────────────────────────────────
console.log('\nno platform is special-cased any more:')
const route = read('app/api/app/links/route.ts')
const dash = read('components/Dashboard.tsx')
check('  the app route has no rank-only list', /RANK_ONLY_PLATFORMS/.test(route), false)
check('  every platform goes through the same mix',
      /const forPlatform = \(p: string\) =>\s*\n?\s*mixed\(/.test(route), true)
check('  the web dashboard has none either', /RANK_ONLY_PLATFORMS/.test(dash), false)
check('  and offers both tabs everywhere',
      /const clusterTabs: \[GroupBy, string\]\[\] = \[\s*\n\s*\['rank', 'Search rank'\],\s*\n\s*\['date', 'Posted date'\],\s*\n\s*\]/.test(dash),
      true)
// The reason is written down where the next person will look for it, because
// the assumption was reasonable when it was made and will look reasonable again.
check('  the route records why the rule was wrong', /the rule had inverted/.test(route), true)
check('  with the measurement that showed it', /EXACTLY ZERO links for every user/.test(route), true)

// A link missing either signal must still be servable — that is what the two
// orderings already do, and it is why no special case is needed.
const cluster = read('lib/cluster.ts')
check('  an unranked link sorts last in the rank ordering',
      /e\.search_rank && e\.search_rank > 0 \? e\.search_rank : Number\.MAX_SAFE_INTEGER/.test(cluster), true)
check('  an undated one sorts last in the date ordering',
      /Number\.NEGATIVE_INFINITY/.test(cluster), true)
// And the mixer must not stall when one side is empty, which is exactly the
// Instagram case: no ranked links at all.
const mix = read('lib/clusterMix.ts')
check('  and an empty side does not end the feed',
      /i >= rankOrder\.length \|\| next\(\) \* 100 < share/.test(mix), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
