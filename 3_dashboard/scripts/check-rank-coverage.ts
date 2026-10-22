// Which links carry a search rank, and which genre they are in.
//
//   node scripts/run-ts-check.mjs scripts/check-rank-coverage.ts
//
// Rank clustering is also a FILTER: filterAdminLinks drops every row flagged
// `date_only`, and orders the rest by `search_rank`. So "rank matches nothing
// for this genre" can mean three different things, with three different fixes:
//
//   no search_rank on the rows      nothing ever gave them one
//   a rank, but date_only is true   the flag is wrong, or arrived later
//   not in the pool at all          replaced, blocked, or never merged
//
// Counted off the pool itself so the flag and the number can be seen apart.
// This is a REPORT, not a pass/fail: what it measures is a property of the
// scraping that has been done, not of the code.
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

function loadEnv(): void {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

async function main(): Promise<void> {
  loadEnv()
  const { loadVideosJson } = await import('../lib/videos')
  const { genreOfRow, GENRE_LABELS, platformFromUrl } = await import('../lib/config')

  const pool = (await loadVideosJson()) as unknown as Record<string, unknown>[]
  console.log(`pool: ${pool.length.toLocaleString()} link(s)\n`)

  type Cell = { total: number; ranked: number; dateOnly: number; rankedButDateOnly: number }
  const by: Record<string, Cell> = {}
  const cell = (g: string): Cell =>
    (by[g] ??= { total: 0, ranked: 0, dateOnly: 0, rankedButDateOnly: 0 })

  for (const v of pool) {
    const g = genreOfRow(v as { genre?: unknown })
    const c = cell(g)
    const rank = Number(v.search_rank ?? 0) || 0
    const dateOnly = Boolean(v.date_only)
    c.total++
    if (rank > 0) c.ranked++
    if (dateOnly) c.dateOnly++
    if (rank > 0 && dateOnly) c.rankedButDateOnly++
  }

  console.log('genre            total     with a rank   date_only   both')
  for (const [g, c] of Object.entries(by).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${(GENRE_LABELS[g] ?? g).padEnd(14)} ${c.total.toLocaleString().padStart(9)} ` +
        `${c.ranked.toLocaleString().padStart(13)} ${c.dateOnly.toLocaleString().padStart(11)} ` +
        `${c.rankedButDateOnly.toLocaleString().padStart(6)}`
    )
  }

  // THE ONE THAT WOULD BE A BUG. A row with a real rank that is nonetheless
  // flagged date_only is excluded from rank clustering while plainly having
  // been found by a search - the flag and the field disagreeing.
  const contradictory = Object.values(by).reduce((n, c) => n + c.rankedButDateOnly, 0)
  console.log(
    `\n${contradictory.toLocaleString()} row(s) carry a number in search_rank AND are flagged date_only` +
      (contradictory ? ' — check the query breakdown below before calling that a bug' : '')
  )

  // Where the ranked ones came from, by platform, since a search is per
  // platform and this says which runs are behind them.
  const ranked = pool.filter((v) => (Number(v.search_rank ?? 0) || 0) > 0)
  const plat: Record<string, number> = {}
  for (const v of ranked) {
    const p = platformFromUrl(String(v.url ?? '')) || 'unknown'
    plat[p] = (plat[p] ?? 0) + 1
  }
  console.log(`\n${ranked.length.toLocaleString()} ranked link(s), by platform:`)
  for (const [p, n] of Object.entries(plat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${p.padEnd(16)} ${n.toLocaleString().padStart(8)}`)
  }

  // And when they were scraped, which dates the searches behind them.
  const days: Record<string, number> = {}
  for (const v of ranked) {
    const at = String(v.scraped_at ?? '').slice(0, 10)
    if (at) days[at] = (days[at] ?? 0) + 1
  }
  const list = Object.entries(days).sort()
  if (list.length) {
    console.log(`\nscraped on: ${list.length} day(s)`)
    for (const [d, n] of list.slice(-8)) console.log(`  ${d}  ${n.toLocaleString()}`)
  } else {
    console.log('\nnone of the ranked rows carries a scraped_at date')
  }

  // THE 723, looked at: which platform and which scrape produced a row that
  // carries a rank and is nonetheless told it is date-only.
  const odd = pool.filter(
    (v) => (Number(v.search_rank ?? 0) || 0) > 0 && Boolean(v.date_only)
  )
  if (odd.length) {
    const where: Record<string, number> = {}
    const when: Record<string, number> = {}
    for (const v of odd) {
      const p = platformFromUrl(String(v.url ?? '')) || 'unknown'
      where[p] = (where[p] ?? 0) + 1
      const d = String(v.scraped_at ?? '').slice(0, 10) || '(no date)'
      when[d] = (when[d] ?? 0) + 1
    }
    console.log('\nthe contradictory rows, by platform:')
    for (const [p, n] of Object.entries(where).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${p.padEnd(16)} ${n.toLocaleString().padStart(7)}`)
    }
    console.log('  by scrape date:', Object.entries(when).sort().map(([d, n]) => `${d}:${n}`).join('  '))
    // Three of them in full: which fields they carry says which code path
    // minted them, which is the only way to find what set the flag.
    console.log('\nthree of them in full:')
    for (const v of odd.slice(0, 3)) console.log('  ' + JSON.stringify(v))
  }

  // A GENUINE SEARCH LINK CARRIES THE QUERY THAT FOUND IT.
  //
  // This is what tells a real search rank from a stale number: scraper.py
  // writes search_query on every row it finds, and nothing else does. A row
  // with a rank but no query has a number that came from somewhere else and
  // means nothing across channels.
  const withQuery = pool.filter((v) => String(v.search_query ?? '').trim() !== '')
  console.log(
    `\n${withQuery.length.toLocaleString()} row(s) carry the search query that found them`
  )
  const q: Record<string, { n: number; ranked: number; dateOnly: number }> = {}
  for (const v of withQuery) {
    const plat = platformFromUrl(String(v.url ?? '')) || 'unknown'
    const k = `${genreOfRow(v as { genre?: unknown })}/${plat}`
    const c = (q[k] ??= { n: 0, ranked: 0, dateOnly: 0 })
    c.n++
    if ((Number(v.search_rank ?? 0) || 0) > 0) c.ranked++
    if (v.date_only) c.dateOnly++
  }
  for (const [k, c] of Object.entries(q).sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `  ${k.padEnd(26)} ${c.n.toLocaleString().padStart(8)}  ranked ${c.ranked.toLocaleString().padStart(7)}  date_only ${c.dateOnly.toLocaleString()}`
    )
  }
  const rankedNoQuery = pool.filter(
    (v) => (Number(v.search_rank ?? 0) || 0) > 0 && String(v.search_query ?? '').trim() === ''
  )
  console.log(
    `\n${rankedNoQuery.length.toLocaleString()} row(s) carry a RANK but no query \u2014 a number that came from somewhere else`
  )

  // The same question for the links that have NO rank: are they all
  // channel-scraped, which is the innocent explanation?
  const unranked = pool.length - ranked.length
  const flagged = Object.values(by).reduce((n, c) => n + c.dateOnly, 0)
  console.log(
    `\n${unranked.toLocaleString()} link(s) carry no rank; ${flagged.toLocaleString()} ` +
      `are flagged date_only.`
  )
  if (unranked !== flagged) {
    console.log(
      `  ${Math.abs(unranked - flagged).toLocaleString()} do not line up — a row with no ` +
        `rank and no flag is invisible to rank clustering anyway, but it is not SAID to be.`
    )
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
