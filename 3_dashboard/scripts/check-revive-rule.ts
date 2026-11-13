// The revive rule against the live database: which links it brings back, and
// what product each kind of link is served.
//
//   node scripts/run-ts-check.mjs scripts/check-revive-rule.ts [--enable]
//
// --enable saves the rule ON with its defaults (cohumanizer, >5 workers,
// scanned only, reserved) before checking.
import { readFileSync } from 'fs'
import { join } from 'path'

function loadEnv(): void {
  const text = readFileSync(join(process.cwd(), '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

async function main(): Promise<void> {
  loadEnv()
  const { ensureGenreRegistry } = await import('../lib/genreStore')
  await ensureGenreRegistry(true)
  const db = await import('../lib/db')
  const { loadVideosJson } = await import('../lib/videos')
  const { PRODUCTS } = await import('../lib/config')

  // Pure: the clamp.
  check('defaults when nothing is stored', db.clampReviveRule(null), db.DEFAULT_REVIVE_RULE)
  check('numbers clamped', db.clampReviveRule({ minUsers: -3 }).minUsers, 0)

  if (process.argv.includes('--enable')) {
    console.log('saved:', JSON.stringify(await db.setReviveRule({ ...db.DEFAULT_REVIVE_RULE, enabled: true })))
  }
  const rule = await db.getReviveRule()
  console.log('rule:', JSON.stringify(rule))
  check('cohumanizer is a product', PRODUCTS.includes(rule.product), true)

  const urls = await db.getReviveUrls(rule)
  const videos = await loadVideosJson()
  const revived = await db.reviveSet(videos as never)
  console.log(`covered by the query: ${urls.size}, in the pool and servable: ${revived.size}`)
  const active = await db.activeProductsForPlatform('tiktok')
  console.log('active on tiktok:', active.join(', '))

  if (!rule.enabled) {
    console.log('rule is off — nothing more to check')
    process.exit(failed ? 1 : 0)
  }
  const humanizers = ['purifytext', 'acoustictext', 'prohumanly', rule.product]
  const one = Array.from(revived)[0] ?? Array.from(urls)[0]
  if (one) {
    check('a covered link: only the product', await db.applyReviveRule(one, humanizers), [rule.product])
    check('a covered link: fair pick gives it', await db.pickFairProductForUrl(one, humanizers), rule.product)
  }
  const other = videos.map((v) => String(v.url)).find((u) => u && !urls.has(u)) as string
  check(
    'any other link: reserved product removed',
    (await db.applyReviveRule(other, humanizers)).includes(rule.product),
    !rule.reserved
  )
  if (one) {
    const { serveCommentForUrl } = await import('../lib/serveComment')
    const s = await serveCommentForUrl(one)
    console.log('served on a covered link:', s.product, '—', s.comment)
    check(
      'serveCommentForUrl serves it (or nothing, if it is not active / has no comments)',
      s.product === rule.product || s.product === null,
      true
    )
  }
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
