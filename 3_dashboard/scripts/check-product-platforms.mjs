// Which platforms each product's comments may be served on.
//
// The rule is one line — a product absent from the setting is allowed
// everywhere, a product present is allowed exactly where it says — and the
// whole risk is in where that line is applied:
//
//   * BEFORE the fair pick, not after. pickFairProductForUrl chooses the
//     product that already leads a video's comment section; filtering its
//     answer would leave a video whose leader is barred with no comment at all,
//     instead of the next product in line.
//   * on EVERY surface. The app asks the server per click, the website picks
//     locally inside the click handler (the clipboard needs a user gesture), and
//     the liker asks its own endpoint. A rule applied to two of the three is a
//     rule the third quietly breaks.
//
// Runs against the real database, on a setting it puts back afterwards.
//
//   node scripts/check-product-platforms.mjs
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

const PLATFORMS = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram']

// The rule, as lib/db.ts activeProductsForPlatform applies it.
const allowedOn = (active, byProduct, platform) =>
  active.filter((p) => {
    const sites = byProduct[p]
    return sites === undefined || sites.includes(platform)
  })

console.log('the rule itself:')
const active = ['purifytext', 'acoustictext', 'prohumanly']
check('  absent means everywhere', allowedOn(active, {}, 'instagram'), active)
check(
  '  present means exactly those',
  allowedOn(active, { purifytext: ['tiktok'] }, 'instagram'),
  ['acoustictext', 'prohumanly']
)
check(
  '  and it still applies on its own platform',
  allowedOn(active, { purifytext: ['tiktok'] }, 'tiktok'),
  active
)
check(
  '  an EMPTY list is a deliberate nowhere',
  allowedOn(active, { purifytext: [] }, 'tiktok'),
  ['acoustictext', 'prohumanly']
)
check(
  '  order is preserved, because the fair pick depends on it',
  allowedOn(active, { acoustictext: ['tiktok'] }, 'tiktok'),
  active
)

// ── against the real database ──────────────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows
const KEY = 'comment_product_platforms'
const before = (await q('SELECT value FROM app_kv WHERE key = $1', [KEY]))[0]?.value ?? null

try {
  const liveActive = JSON.parse(
    (await q('SELECT active_comment_products v FROM app_state WHERE id = 1'))[0]?.v ?? '[]'
  )
  console.log(`\nactive products right now: ${liveActive.join(', ') || '(none)'}`)

  console.log('\nnothing is restricted until an admin restricts something:')
  await db.query('DELETE FROM app_kv WHERE key = $1', [KEY])
  const empty = JSON.parse(
    (await q('SELECT value FROM app_kv WHERE key = $1', [KEY]))[0]?.value ?? 'null'
  )
  check('  no setting stored', empty, null)
  for (const plat of PLATFORMS)
    check(`  ${plat}: every active product`, allowedOn(liveActive, {}, plat), liveActive)

  console.log('\nnarrowing one product changes only that product:')
  const first = liveActive[0]
  if (first) {
    await db.query(
      `INSERT INTO app_kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [KEY, JSON.stringify({ [first]: ['tiktok'] })]
    )
    const saved = JSON.parse((await q('SELECT value FROM app_kv WHERE key = $1', [KEY]))[0].value)
    check('  it is stored', saved, { [first]: ['tiktok'] })
    check(`  ${first} is served on tiktok`, allowedOn(liveActive, saved, 'tiktok').includes(first), true)
    check(`  and not on instagram`, allowedOn(liveActive, saved, 'instagram').includes(first), false)
    check(
      '  the others are untouched everywhere',
      allowedOn(liveActive, saved, 'instagram'),
      liveActive.filter((p) => p !== first)
    )
  }
} finally {
  if (before === null) await db.query('DELETE FROM app_kv WHERE key = $1', [KEY])
  else
    await db.query(
      `INSERT INTO app_kv (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [KEY, before]
    )
  await db.end()
}

// ── applied on every surface, and in the right order ───────────────────────
const dbSrc = read('lib/db.ts')
const serve = read('lib/serveComment.ts')
const liker = read('app/api/links/comment/route.ts')
const webApi = read('app/api/comments/route.ts')
const appApi = read('app/api/app/comments/route.ts')
const dash = read('components/Dashboard.tsx')

console.log('\nthe rule lives in one place:')
check('  one helper', (dbSrc.match(/export async function activeProductsForPlatform/g) ?? []).length, 1)
check('  absent = everywhere, stated in code', /allowed === undefined \|\| allowed\.includes\(p\)/.test(dbSrc), true)
check(
  '  all-platforms is stored as unrestricted',
  /if \(platforms\.length === CLICK_PLATFORMS\.length\) continue/.test(dbSrc),
  true
)

console.log('\nand every surface applies it:')
check('  app + website clicks (serveCommentForUrl)', /activeProductsForPlatform\(platform\)/.test(serve), true)
check('  before the fair pick, not after', serve.indexOf('activeProductsForPlatform') < serve.indexOf('pickFairProductForUrl('), true)
check('  the liker endpoint', /activeProductsForPlatform\(platformFromUrl\(url\)\)/.test(liker), true)
check('  the website pool carries the map', /productPlatforms,/.test(webApi), true)
check('  the page filters its own pick by it', /sites === undefined \|\| sites\.includes\(v\.platform\)/.test(dash), true)
check('  including the fallback pools', (dash.match(/allowed\(/g) ?? []).length >= 3, true)
check('  and the app pool carries it too', /productPlatforms,/.test(appApi), true)

console.log('\nthe admin panel can set it, and warns about the dead ends:')
const ui = read('components/ActiveProducts.tsx')
check('  a platform row per product', /CLICK_PLATFORMS\.map\(\(plat\) =>/.test(ui), true)
check('  the whole map is sent, not one product', /for \(const p of products \?\? \[\]\) next\[p\]/.test(ui), true)
check('  active-but-nowhere is called out', /Active but allowed on no platform/.test(ui), true)
check('  and a platform nothing covers', /links\s*\n\s*there will be served no comment/.test(ui), true)
check(
  '  saving platforms does not reset the active list',
  /if \(b\?\.platforms && typeof b\.platforms === 'object'/.test(read('app/api/admin/active-products/route.ts')),
  true
)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
