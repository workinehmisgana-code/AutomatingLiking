// Which staged links belong to which genre, decided by the searches that found
// their channels.
//
//   node scripts/run-ts-check.mjs scripts/verify-genre-from-searches.ts
//   node scripts/run-ts-check.mjs scripts/verify-genre-from-searches.ts --apply
//
// WHY THE SEARCHES AND NOT THE POOL. The staging list was extracted from
// channels, and the extract route stamped every link with the default genre
// because it only knew the genre of hand-added channels. The pool cannot say
// either: its website stamping was lost when a deploy without genre support
// rewrote those rows.
//
// But the scraper's own output can. A search run is one genre by construction -
// "ai website builder" and the rest of that phrase set find website channels,
// "humanizer" finds humanizer ones - and the CSV it writes names every channel
// it found. So the CSVs ARE the record of which channel belongs to which genre,
// and they are the only record left.
//
// A channel found by searches of BOTH genres is left alone rather than guessed
// at: it posts about both, and the staged link could be either. Same for a
// channel no search found.
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// The working directory, not a count of '..' from __dirname: the compiled file
// lands at .checkbuild/scripts/x.js or .checkbuild/x.js depending on whether
// the script imports anything outside scripts/, so its depth is not fixed.
// run-ts-check.mjs runs it with the project root as cwd.
const ROOT = process.cwd()
const RESULTS = join(ROOT, '..', '1_tiktok_search_scraper', 'results')

function loadEnv(): void {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

/** Every @handle named by a CSV's url column. */
function handlesIn(file: string): Set<string> {
  const out = new Set<string>()
  const text = readFileSync(file, 'utf8')
  // Array.from, not a spread: the project tsconfig has no target, so it is
  // checked as ES5 and an iterator cannot be spread. See run-ts-check.mjs.
  for (const m of Array.from(text.matchAll(/tiktok\.com\/@([^/?#",\s]+)/gi))) {
    out.add(m[1].toLowerCase())
  }
  return out
}

/**
 * A search CSV's genre, from the phrases in its own filename.
 *
 * The scraper names a file after the first phrase of the run, which is the one
 * thing in the filename that says what was being looked for. Read rather than
 * configured: the files are the evidence and this must not need a second list
 * kept beside them.
 */
function genreOfFile(name: string): 'website' | 'slides' | 'humanizer' | null {
  const n = name.toLowerCase()
  if (!n.startsWith('tiktok_')) return null
  if (/website|site_builder|no_code|webflow|wix/.test(n)) return 'website'
  if (/slide|presentation|powerpoint|deck|ppt/.test(n)) return 'slides'
  if (/humaniz|turnitin|detector|gptzero|bypass|purifytext|acoustictext|prohumanly|humlexic/.test(n))
    return 'humanizer'
  return null
}

async function main(): Promise<void> {
  loadEnv()
  const apply = process.argv.includes('--apply')

  const files = readdirSync(RESULTS).filter((f) => f.endsWith('.csv'))
  const byGenre = new Map<string, Set<string>>()
  console.log('search CSVs, by the genre their phrases were for:')
  for (const f of files) {
    const g = genreOfFile(f)
    if (!g) continue
    const hs = handlesIn(join(RESULTS, f))
    const set = byGenre.get(g) ?? new Set<string>()
    hs.forEach((h) => set.add(h))
    byGenre.set(g, set)
    console.log(`  ${g.padEnd(10)} ${String(hs.size).padStart(5)} channel(s)  ${f}`)
  }
  for (const [g, set] of Array.from(byGenre.entries())) {
    console.log(`\n${g}: ${set.size.toLocaleString()} distinct channel(s) across its runs`)
  }

  const website = byGenre.get('website') ?? new Set<string>()
  const humanizer = byGenre.get('humanizer') ?? new Set<string>()
  const slides = byGenre.get('slides') ?? new Set<string>()
  const both = Array.from(website).filter((h) => humanizer.has(h))
  console.log(`\n${both.length} channel(s) were found by BOTH a website and a humanizer search`)

  const pg = await import('pg')
  const Pool = (pg as unknown as { Pool: new (o: unknown) => any }).Pool
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })

  try {
    const { rows } = await db.query(
      `SELECT COALESCE(NULLIF(account, ''), '') AS account, COUNT(*)::int AS n
         FROM verify_link GROUP BY 1`
    )
    const verdict = new Map<string, string>()
    const tally: Record<string, { channels: number; links: number }> = {}
    const add = (k: string, links: number) => {
      const t = (tally[k] ??= { channels: 0, links: 0 })
      t.channels++
      t.links += links
    }
    for (const r of rows as { account: string; n: number }[]) {
      const h = r.account.toLowerCase()
      if (!h) {
        add('no channel named', r.n)
        continue
      }
      const hits = [
        website.has(h) ? 'website' : '',
        humanizer.has(h) ? 'humanizer' : '',
        slides.has(h) ? 'slides' : '',
      ].filter(Boolean)
      if (hits.length === 1) {
        verdict.set(r.account, hits[0])
        add(hits[0], r.n)
      } else if (hits.length > 1) {
        add(`ambiguous (${hits.join('+')})`, r.n)
      } else {
        add('no search found this channel', r.n)
      }
    }

    console.log('\nthe staging list, split by which search found the channel:')
    for (const [k, t] of Object.entries(tally).sort((a, b) => b[1].links - a[1].links)) {
      console.log(`  ${k.padEnd(34)} ${String(t.links).padStart(7)} link(s)  ${t.channels} channel(s)`)
    }

    const toSet = Array.from(verdict.entries()).filter(([, g]) => g !== 'humanizer')
    if (!toSet.length) {
      console.log('\nnothing to re-file.')
      return
    }
    console.log(`\n${toSet.length} channel(s) would be re-filed off humanizer.`)
    if (!apply) {
      console.log('--apply was not passed: nothing was written.')
      return
    }
    // One statement per genre, not per channel.
    let changed = 0
    for (const g of ['website', 'slides']) {
      const handles = toSet.filter(([, v]) => v === g).map(([a]) => a)
      if (!handles.length) continue
      const res = await db.query(
        `UPDATE verify_link SET genre = $1 WHERE lower(account) = ANY($2::text[])`,
        [g, handles.map((h) => h.toLowerCase())]
      )
      changed += res.rowCount ?? 0
      console.log(`  ${g}: ${(res.rowCount ?? 0).toLocaleString()} link(s)`)
    }
    console.log(`\nre-filed ${changed.toLocaleString()} staged link(s).`)
  } finally {
    await db.end()
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
