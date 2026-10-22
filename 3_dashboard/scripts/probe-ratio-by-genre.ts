// Why do website-genre links show no Ratio when humanizer ones do?
//
//   node scripts/run-ts-check.mjs scripts/probe-ratio-by-genre.ts
//
// The Ratio column is activePct: of everything we hold from this link's
// CHANNEL, what share is still active rather than blocked. It is null when the
// channel cannot be named, or when nothing of that channel is counted.
//
// Measured rather than reasoned about: the same build the admin page uses, then
// the coverage of activePct split by genre.
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()

function loadEnv(): void {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

async function main(): Promise<void> {
  loadEnv()
  const { buildAdminLinks } = await import('../lib/adminLinks')

  const built = await buildAdminLinks('')
  const rows = built.rows
  console.log(`${rows.length.toLocaleString()} link(s) built\n`)

  type Cell = { total: number; withPct: number; nullPct: number; blocked: number; clicked: number }
  const by: Record<string, Cell> = {}
  for (const l of rows) {
    const g = l.genre || '(none)'
    const c = (by[g] ??= { total: 0, withPct: 0, nullPct: 0, blocked: 0, clicked: 0 })
    c.total++
    if (l.activePct === null || l.activePct === undefined) c.nullPct++
    else c.withPct++
    if (l.blocked) c.blocked++
    if (l.clicks > 0) c.clicked++
  }

  console.log('genre          links    with a ratio   no ratio   blocked   clicked')
  for (const [g, c] of Object.entries(by).sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${g.padEnd(12)} ${c.total.toLocaleString().padStart(8)} ` +
        `${c.withPct.toLocaleString().padStart(13)} ${c.nullPct.toLocaleString().padStart(10)} ` +
        `${c.blocked.toLocaleString().padStart(9)} ${c.clicked.toLocaleString().padStart(9)}`
    )
  }

  // If a genre has rows without a ratio, say WHY for a few of them: a channel
  // that cannot be named, or one with nothing counted against it.
  for (const [g, c] of Object.entries(by)) {
    if (!c.nullPct) continue
    console.log(`\n${g}: five of the ${c.nullPct.toLocaleString()} without a ratio`)
    let shown = 0
    for (const l of rows) {
      if ((l.genre || '(none)') !== g) continue
      if (l.activePct !== null && l.activePct !== undefined) continue
      const named = /tiktok\.com\/@([A-Za-z0-9._]+)|youtube\.com\/@|instagram\.com\/[^/]+\/(p|reel)\//i.test(l.url)
      console.log(`  channel nameable: ${named ? 'yes' : 'NO '}   ${l.url.slice(0, 70)}`)
      if (++shown >= 5) break
    }
  }

  // THE OTHER READING OF "ratio": the Clicked by column shows clicks / quota.
  // A quota of zero would print nothing useful either, and it is derived from
  // the like count - which a freshly uploaded link may not carry yet.
  console.log('\nthe clicks / quota column, by genre:')
  const q: Record<string, { n: number; noQuota: number; noLikes: number }> = {}
  for (const l of rows) {
    const g = l.genre || '(none)'
    const c = (q[g] ??= { n: 0, noQuota: 0, noLikes: 0 })
    c.n++
    if (!l.retireAt) c.noQuota++
    if (!l.like_count) c.noLikes++
  }
  for (const [g, c] of Object.entries(q).sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `  ${g.padEnd(12)} ${c.n.toLocaleString().padStart(8)} links, ` +
        `${c.noQuota.toLocaleString()} with no quota, ${c.noLikes.toLocaleString()} with no like count`
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
