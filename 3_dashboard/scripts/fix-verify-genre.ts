// Staged links filed under the wrong genre, and putting them right.
//
//   node scripts/run-ts-check.mjs scripts/fix-verify-genre.ts              report
//   node scripts/run-ts-check.mjs scripts/fix-verify-genre.ts --apply      fix from the pool
//   node scripts/run-ts-check.mjs scripts/fix-verify-genre.ts --set website --apply
//
// --set re-files the WHOLE staging list as one genre, for when the pool can no
// longer say: an extraction run stages one batch from one set of channels, and
// if the channels' genre was lost before it ran, the only thing that knows what
// that batch was is whoever started it. It prints the channels first and
// refuses without --apply, because it is a blunt instrument aimed at thousands
// of rows.
//
// WHAT WENT WRONG. The extract route stamped each staged link with the genre of
// the channel it came from, but it only knew the genre of HAND-ADDED channels:
// anything reached by an ordinary ranked extraction fell through to the default
// and was staged as humanizer. While every channel in the pool was a humanizer
// channel that was invisible. It stopped being invisible the moment website
// channels existed, and every video extracted from one has been filed as a
// humanizer link since.
//
// Why it matters beyond a wrong label: the genre decides which product's
// comments can ever be served on a link. Merged as humanizer, a website video
// gets humanizer comments under it - or, now that the serve path narrows by
// genre, no comment at all.
//
// The channel's genre is read from rankChannels(), the same function the route
// now uses, so this cannot disagree with what a future extraction will do.
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
  const apply = process.argv.includes('--apply')
  const setAt = process.argv.indexOf('--set')
  const setGenre = setAt >= 0 ? String(process.argv[setAt + 1] ?? '') : ''
  const { rankChannels } = await import('../lib/channelRank')
  const { GENRE_LABELS, DEFAULT_GENRE } = await import('../lib/config')

  const { GENRES, isGenre } = await import('../lib/config')
  if (setAt >= 0 && !isGenre(setGenre)) {
    console.error(`--set needs one of: ${GENRES.join(', ')}`)
    process.exitCode = 2
    return
  }

  const pg = await import('pg')
  const Pool = (pg as unknown as { Pool: new (o: unknown) => any }).Pool
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })

  try {
    // ── --set: the whole list, one genre ───────────────────────────
    if (setGenre) {
      const chans = await db.query(
        `SELECT COALESCE(NULLIF(account, ''), '(no channel)') AS account,
                COALESCE(NULLIF(genre, ''), $1) AS genre, COUNT(*)::int AS n
           FROM verify_link GROUP BY 1, 2 ORDER BY 3 DESC`,
        [DEFAULT_GENRE]
      )
      const sum = (chans.rows as { n: number }[]).reduce((a, r) => a + r.n, 0)
      console.log(
        `\nthe whole staging list is ${sum.toLocaleString()} link(s) from ${chans.rows.length} channel(s)`
      )
      for (const r of (chans.rows as { account: string; genre: string; n: number }[]).slice(0, 12)) {
        console.log(`  @${r.account.padEnd(26)} ${String(r.n).padStart(6)}  now ${r.genre}`)
      }
      if (chans.rows.length > 12) console.log(`  … and ${chans.rows.length - 12} more`)
      console.log(`\nwould re-file every one of them as ${setGenre}.`)
      if (!apply) {
        console.log('--apply was not passed: nothing was written.')
        return
      }
      const res = await db.query(`UPDATE verify_link SET genre = $1`, [setGenre])
      console.log(`re-filed ${(res.rowCount ?? 0).toLocaleString()} staged link(s) as ${setGenre}.`)
      return
    }

    // Every channel's genre, by the rule the extraction now uses: the genre
    // somebody stated when adding it, else the genre most of its pool links
    // already hold.
    const ranked = await rankChannels()
    const genreOf = new Map<string, string>()
    for (const c of ranked) genreOf.set(c.handle.toLowerCase(), c.genre)
    const nonDefault = ranked.filter((c) => c.genre !== DEFAULT_GENRE)
    console.log(
      `${ranked.length.toLocaleString()} channel(s) ranked; ` +
        `${nonDefault.length.toLocaleString()} are not ${DEFAULT_GENRE}`
    )
    for (const c of nonDefault.slice(0, 10)) {
      console.log(`  @${c.handle} (${c.platform}) -> ${GENRE_LABELS[c.genre] ?? c.genre}, ${c.links} link(s) in the pool`)
    }

    const { rows } = await db.query(
      `SELECT url, account, COALESCE(NULLIF(genre, ''), $1) AS genre
         FROM verify_link
        WHERE account IS NOT NULL AND btrim(account) <> ''`,
      [DEFAULT_GENRE]
    )
    console.log(`\n${rows.length.toLocaleString()} staged link(s) with a channel named`)

    // A staged link whose channel we cannot find is left alone: its genre is
    // not wrong, it is unknown, and guessing is what caused this.
    const wrong = new Map<string, { urls: string[]; from: string; to: string }>()
    let unknown = 0
    for (const r of rows as { url: string; account: string; genre: string }[]) {
      const want = genreOf.get(String(r.account).toLowerCase())
      if (!want) {
        unknown++
        continue
      }
      if (want === r.genre) continue
      const key = `${r.account}:${r.genre}->${want}`
      const e = wrong.get(key) ?? { urls: [], from: r.genre, to: want }
      e.urls.push(r.url)
      wrong.set(key, e)
    }

    const total = Array.from(wrong.values()).reduce((n, e) => n + e.urls.length, 0)
    console.log(`${unknown.toLocaleString()} link(s) whose channel is not in the ranking - left alone`)
    console.log(`\n${total.toLocaleString()} link(s) are filed under the wrong genre:`)
    for (const [key, e] of Array.from(wrong.entries()).sort(
      (a, b) => b[1].urls.length - a[1].urls.length
    )) {
      const handle = key.split(':')[0]
      console.log(
        `  @${handle.padEnd(26)} ${String(e.urls.length).padStart(6)} link(s)  ` +
          `${GENRE_LABELS[e.from] ?? e.from} -> ${GENRE_LABELS[e.to] ?? e.to}`
      )
    }

    if (!total) {
      console.log('\nnothing to fix.')
      return
    }
    if (!apply) {
      console.log('\n--apply was not passed: nothing was written.')
      return
    }

    // One statement per (channel, target genre) rather than one per link:
    // 18,000 single-row updates is 18,000 round trips.
    let changed = 0
    for (const e of Array.from(wrong.values())) {
      const res = await db.query(
        `UPDATE verify_link SET genre = $1 WHERE url = ANY($2::text[])`,
        [e.to, e.urls]
      )
      changed += res.rowCount ?? 0
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
