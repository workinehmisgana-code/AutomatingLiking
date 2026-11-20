// ONE-TIME SWEEP: every search-extracted link in the pool is title-checked
// against its genre, the way an upload checks new links. Unrelated ones are
// moved to Links to verify (keeping their keyword and rank, so verifying one
// by hand puts it back in the SEARCH clusters); related ones stay.
//
// Why: the upload check only judges links NEW to the pool. Links that came in
// before it existed were never judged, and a re-upload just refreshes them —
// e.g. two Ethiopian music albums sitting at ranks 1-2 of "maskai humanizer".
//
//   node scripts/run-ts-check.mjs scripts/sweep-search-links.ts <cache.json> [--genre g] [--apply]
//
// Without --apply nothing is changed: it judges, caches the verdicts in
// <cache.json> (so a second run, or the --apply run, asks the model nothing
// twice) and writes <cache>.unrelated.csv to read through. Never moved:
// links with no title, links the model gave no answer for, links whose title
// contains a genre keyword.
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const args = process.argv.slice(2)
const cachePath = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--genre')
const apply = args.includes('--apply')
const onlyGenre = args.includes('--genre') ? args[args.indexOf('--genre') + 1] : ''
if (!cachePath) throw new Error('usage: sweep-search-links.ts <cache.json> [--genre g] [--apply]')

type V = Record<string, unknown>
type Cached = { genre: string; related: boolean; rule: string; reason: string; title: string }

const handleOf = (url: string): string => url.match(/\/@([^/?#]+)/)?.[1] ?? ''

async function main(): Promise<void> {
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const videos = await import('../lib/videos')
  // Always a fresh download: the cache is dropped before every read.
  const load = async (): Promise<V[]> => {
    videos.invalidatePoolFile()
    return (await videos.loadVideosJson()) as unknown as V[]
  }
  const { pool, getBlockedIndex, saveVerifyLinks } = await import('../lib/db')
  const { classifyWithReasonsByGenre } = await import('../lib/titleClassify')
  const { genreOfRow } = await import('../lib/config')

  const cache: Record<string, Cached> = existsSync(cachePath!) ? JSON.parse(readFileSync(cachePath!, 'utf8')) : {}
  const all = await load()
  const blocked = await getBlockedIndex()
  const search = all.filter((v) => {
    if (!(Number(v.search_rank) > 0) || v.date_only === true) return false
    const g = genreOfRow({ genre: v.genre as string })
    if (onlyGenre && g !== onlyGenre) return false
    return !blocked.get(String(v.url))?.has(g)
  })
  const urls = search.map((v) => String(v.url))
  const t = await pool.query<{ url: string; title: string }>(
    `SELECT url, title FROM link_title WHERE url = ANY($1) AND length(title) > 0`, [urls])
  const titleOf = new Map(t.rows.map((r) => [r.url, r.title]))
  for (const v of search) if (v.title && !titleOf.has(String(v.url))) titleOf.set(String(v.url), String(v.title))
  // INSTAGRAM'S ALT TEXT IS NOT A CAPTION. "Photo by ASPIRANT | STUDYGRAM on
  // August 25, 2026. May be an image of …" says nothing about the post, and
  // the model called 437 of them unrelated — a studygram photo found by
  // "study tips" among them. No title, then, unless the alt text read words
  // off the image ("… text that says '…'").
  const ALT_TEXT = /^Photo (?:by|shared by) .+ on [A-Z][a-z]+ \d{1,2}, \d{4}/
  for (const [u, t] of Array.from(titleOf)) {
    if (ALT_TEXT.test(t) && !/text that says/i.test(t)) titleOf.delete(u)
  }

  const todo = search
    .filter((v) => titleOf.has(String(v.url)) && !cache[String(v.url)])
    .map((v) => ({ url: String(v.url), title: titleOf.get(String(v.url))!, genre: genreOfRow({ genre: v.genre as string }) }))
  console.log(`${search.length} search-extracted links${onlyGenre ? ` in ${onlyGenre}` : ''} (not blocked); ` +
    `${search.length - search.filter((v) => titleOf.has(String(v.url))).length} have no title; ` +
    `${todo.length} still to judge, ${Object.keys(cache).length} cached`)

  // 1,000 titles a round = 10 model calls at once (classifyWithReasonsByGenre
  // splits by genre and into 100s). Saved after every round.
  const ROUND = 1000
  for (let i = 0; i < todo.length; i += ROUND) {
    const part = todo.slice(i, i + ROUND)
    const started = Date.now()
    const verdicts = await classifyWithReasonsByGenre(part)
    const byUrl = new Map(verdicts.map((v) => [v.url, v]))
    let rel = 0, unr = 0, none = 0
    for (const it of part) {
      const v = byUrl.get(it.url)
      if (!v || v.rule === 'unanswered') { none++; continue } // asked again next run
      cache[it.url] = { genre: it.genre, related: v.related, rule: v.rule, reason: v.reason, title: it.title.slice(0, 200) }
      if (v.related) rel++; else unr++
    }
    writeFileSync(cachePath!, JSON.stringify(cache))
    console.log(`  ${Math.min(i + ROUND, todo.length)}/${todo.length}: ${rel} related, ${unr} unrelated, ` +
      `${none} unanswered (${((Date.now() - started) / 1000).toFixed(0)} s)`)
  }

  // ── the report ──────────────────────────────────────────────────────────────
  const inScope = new Set(urls)
  const unrelated = Object.entries(cache).filter(([u, c]) => inScope.has(u) && titleOf.has(u) && !c.related)
  const per = new Map<string, { n: number; out: number }>()
  for (const v of search) {
    const c = cache[String(v.url)]
    const k = `${genreOfRow({ genre: v.genre as string })} / ${v.platform}`
    const e = per.get(k) ?? { n: 0, out: 0 }
    e.n++
    if (c && !c.related && titleOf.has(String(v.url))) e.out++
    per.set(k, e)
  }
  console.log('\nunrelated, by genre / platform:')
  for (const [k, e] of Array.from(per).sort((a, b) => b[1].out - a[1].out))
    console.log(`  ${k.padEnd(32)} ${String(e.out).padStart(5)} of ${e.n}`)
  const csv = ['url,genre,search_query,search_rank,title,reason']
  const vOf = new Map(search.map((v) => [String(v.url), v]))
  const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""').replace(/\s+/g, ' ')}"`
  for (const [u, c] of unrelated) {
    const v = vOf.get(u)!
    csv.push([q(u), q(c.genre), q(v.search_query), q(v.search_rank), q(c.title), q(c.reason)].join(','))
  }
  writeFileSync(cachePath!.replace(/\.json$/, '') + '.unrelated.csv', '﻿' + csv.join('\n'))
  console.log(`\n${unrelated.length} unrelated in total -> ${cachePath!.replace(/\.json$/, '')}.unrelated.csv`)

  if (!apply) {
    console.log('dry run: nothing changed. Add --apply to move them to Links to verify.')
    process.exit(0)
  }

  // ── apply: stage first, then take them out of the pool ─────────────────────
  const move = new Set(unrelated.map(([u]) => u))
  const rows = search.filter((v) => move.has(String(v.url)))
  const written = await saveVerifyLinks(rows.map((v) => ({
    url: String(v.url),
    account: String(v.author || handleOf(String(v.url))),
    view_count: v.like_count as number,
    heart_count: v.heart_count as number,
    posted_date: v.posted_date as string,
    title: titleOf.get(String(v.url)) ?? '',
    genre: genreOfRow({ genre: v.genre as string }),
    search_query: v.search_query as string,
    search_rank: Number(v.search_rank) > 0 ? Number(v.search_rank) : 1,
  })) as never)
  console.log(`staged ${written} in Links to verify`)
  if (written < 0) throw new Error('staging failed; the pool is unchanged')

  // Re-read the pool right before writing it, so an upload since the start
  // is not undone; only the moved URLs are taken out.
  const fresh = await load()
  const kept = fresh.filter((v) => !move.has(String(v.url)) || !(Number(v.search_rank) > 0))
  const { put } = await import('@vercel/blob')
  videos.invalidatePoolFile()
  await put('videos.json', JSON.stringify(kept), {
    access: 'public', addRandomSuffix: false, contentType: 'application/json',
  })
  videos.invalidatePoolFile()
  console.log(`pool: ${fresh.length} -> ${kept.length} links (${fresh.length - kept.length} moved out)`)
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
