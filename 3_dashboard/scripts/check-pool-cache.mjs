// Is the link pool still being read out of the database once per request?
//
// MEASURED BEFORE THE CACHE EXISTED, on the live database:
//
//   20.5 billion rows read by sequential scans
//     blocked_link   74,238 full scans × ~100k rows = 7.40 billion
//     clicked_link   79,057 full scans ×  ~73k rows = 5.75 billion
//     link_category  21,174 full scans              = 3.08 billion
//     link_title     16,607 full scans              = 2.35 billion
//
// The database is 368 MB, so 1.38 TB of egress in a month is the whole thing read
// about 3,750 times over — 58% of the Neon bill, with the compute charge on top
// because an instance handed a hundred full scans a minute never suspends.
//
// This checks the shape of the fix and then prints the counters, so the next run
// of it shows whether they are still climbing.
//
//   node scripts/check-pool-cache.mjs
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
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const cache = read('lib/poolCache.ts')
const db = read('lib/db.ts')
const links = read('lib/adminLinks.ts')
const videos = read('lib/videos.ts')

console.log('the cache has the two properties that matter:')
// A cache that only helps after the first result is useless exactly when the load
// is worst: twenty requests on a cold entry must make one query, not twenty.
check('  single flight', /if \(hit\?\.inflight\) return hit\.inflight/.test(cache), true)
check('  and a failure is never cached', /store\.delete\(key\)/.test(cache), true)
check('  invalidation by prefix', /export function invalidate\(prefix: string\)/.test(cache), true)
check('  the measurement is written down', /20\.5 BILLION/.test(cache), true)
check('  and why a cache is the right answer', /the same answer, bought again/.test(cache), true)

console.log('\nevery whole-table loader is wrapped, at its definition:')
for (const [fn, key] of [
  ['getBlockedUrls', 'blockedUrls'],
  ['getLinkTitles', 'linkTitles'],
  ['getLinkCategories', 'linkCategories'],
  ['getLinkStats', 'linkStats'],
  ['getChannelBios', 'channelBios'],
  ['getClickCountsByUrl', 'clickCounts'],
  ['getClickCountsByProductAndUrl', 'clickCountsByProduct'],
  ['getUnrelatedCountsByUrl', 'unrelatedCounts'],
  ['getUrlsWithProductComments', 'urlsWithOurs'],
  ['getProductCommentCountsByUrl', 'ourCountsByUrl'],
  ['getScanCoverage', 'scanCoverage'],
  ['getEffectivePlatformLimits', 'platformLimits'],
]) {
  check(`  ${fn}`, new RegExp(`return cached\\('${key}'`).test(db) && db.includes(`${fn}Uncached`), true)
}
// Wrapped at the definition rather than at the call sites, because there are
// twenty-odd callers and a cache that must be remembered will be forgotten.
check('  one place, not twenty call sites', (db.match(/Uncached\(\)/g) ?? []).length >= 12, true)

console.log('\nand the pool file is not downloaded per request either:')
check('  videos.json is cached', /return cached\('videosJson'/.test(videos), true)
check('  with an explicit invalidator', /export function invalidatePoolFile/.test(videos), true)
check('  called when the pool is replaced',
      /invalidatePoolFile\(\)/.test(read('lib/verifyMerge.ts')) &&
        /invalidatePoolFile\(\)/.test(read('app/api/upload/route.ts')), true)

console.log('\nthe assembly itself is cached, for the CPU:')
check('  buildAdminLinks is wrapped', /return cached\(`adminLinks:\$\{product\}`/.test(links), true)
check('  keyed by product', /adminLinks:\$\{product\}/.test(links), true)
check('  and says why it is keyed that way', /scoped to it/.test(links), true)

console.log('\nan admin write drops the answer it changes:')
for (const [fn, key] of [
  ['blockLink', 'blockedUrls'],
  ['unblockLinks', 'blockedUrls'],
  ['saveLinkTitles', 'linkTitles'],
  ['saveLinkCategories', 'linkCategories'],
  ['saveLinkScan', 'scanCoverage'],
  ['setPlatformLimit', 'platformLimits'],
]) {
  const body = db.slice(db.indexOf(`export async function ${fn}(`), db.indexOf(`export async function ${fn}(`) + 900)
  check(`  ${fn} → ${key}`, body.includes(`invalidate('${key}')`), true)
}
// Clicks are the exception, and it is a decision rather than an oversight.
check('  clicks ride the TTL instead', /would defeat the cache entirely/.test(db), true)

// ── the counters, for the next run to compare against ──────────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const { rows } = await pool
  .query(
    `SELECT relname, seq_scan::int scans, seq_tup_read::bigint rows_read
       FROM pg_stat_user_tables
      WHERE relname IN ('blocked_link','clicked_link','link_category','link_title',
                        'link_stat','unrelated_link','link_comment_scan','link_product_comment')
      ORDER BY seq_tup_read DESC`
  )
  .catch(() => ({ rows: [] }))
console.log('\nfull-table scans so far (all time — watch these stop climbing):')
let total = 0n
for (const r of rows) {
  total += BigInt(r.rows_read)
  console.log(
    `   ${r.relname.padEnd(22)} ${String(r.scans).padStart(7)} scans  ` +
      `${Number(r.rows_read).toLocaleString().padStart(15)} rows`
  )
}
console.log(`   ${'TOTAL'.padEnd(22)} ${' '.repeat(13)} ${Number(total).toLocaleString().padStart(15)} rows`)
console.log('   Run this again after a day of traffic: the scan counts should barely move.')
await pool.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
