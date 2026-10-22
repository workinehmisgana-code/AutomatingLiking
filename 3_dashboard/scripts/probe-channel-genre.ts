// Why no channel comes out as a website channel, and why the handles do not
// line up with the staged links.
//
//   node scripts/run-ts-check.mjs scripts/probe-channel-genre.ts
//
// Two separate questions, and they have to be asked apart:
//   does rankChannels see the website links at all?
//   do verify_link.account and ChannelRow.handle spell a channel the same way?
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
  const { rankChannels } = await import('../lib/channelRank')
  const { loadVideosJson } = await import('../lib/videos')
  const { genreOfRow } = await import('../lib/config')

  // 1. Does the pool still hold website links, and can their channel be named?
  const pool = (await loadVideosJson()) as unknown as Record<string, unknown>[]
  const web = pool.filter((v) => genreOfRow(v as { genre?: unknown }) === 'website')
  console.log(`pool: ${pool.length.toLocaleString()} link(s), ${web.length.toLocaleString()} website`)
  const handleOf = (u: string): string =>
    (String(u).match(/(?:tiktok\.com|instagram\.com|youtube\.com)\/@([^/?#]+)/i)?.[1] ?? '').toLowerCase()
  const webHandles = new Map<string, number>()
  for (const v of web) {
    const h = handleOf(String(v.url ?? ''))
    if (h) webHandles.set(h, (webHandles.get(h) ?? 0) + 1)
  }
  console.log(`  across ${webHandles.size} nameable channel(s); top five:`)
  for (const [h, n] of Array.from(webHandles).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`    @${h} ${n}`)
  }

  // 2. What does rankChannels say about those same channels?
  const ranked = await rankChannels()
  console.log(`\nranked: ${ranked.length.toLocaleString()} channel(s)`)
  const byHandle = new Map(ranked.map((c) => [c.handle.toLowerCase(), c]))
  console.log('  the five website-heaviest channels, as the ranking sees them:')
  for (const [h] of Array.from(webHandles).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    const c = byHandle.get(h)
    console.log(
      c ? `    @${h} -> genre ${c.genre}, ${c.links} link(s), platform ${c.platform}`
        : `    @${h} -> NOT IN THE RANKING`
    )
  }

  // 3. How are the two sides spelling a handle?
  const pg = await import('pg')
  const Pool = (pg as unknown as { Pool: new (o: unknown) => any }).Pool
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  })
  try {
    const { rows } = await db.query(
      `SELECT account, COUNT(*)::int AS n FROM verify_link
        WHERE account IS NOT NULL AND btrim(account) <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`
    )
    console.log('\nthe staged links’ busiest channels, and whether the ranking knows them:')
    for (const r of rows as { account: string; n: number }[]) {
      const c = byHandle.get(String(r.account).toLowerCase())
      console.log(
        `  ${JSON.stringify(r.account).padEnd(28)} ${String(r.n).padStart(6)}  ` +
          (c ? `ranked, genre ${c.genre}` : 'NOT IN THE RANKING')
      )
    }
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
