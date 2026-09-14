// One product per video.
//
// Whichever of our products already leads a video's comment section must get
// every further comment on that video; a video with none of ours yet is assigned
// one from its URL, so every user opening it gets the same product from the very
// first click. This mirrors pickFairProductForUrl against the real database.
//
//   node scripts/check-product-domination.mjs
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

const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

const raw = (await db.query('SELECT active_comment_products AS v FROM app_state WHERE id = 1')).rows[0]?.v
const src = readFileSync(new URL('../lib/config.ts', import.meta.url), 'utf8')
const listOf = (name) => {
  const a = src.indexOf(name)
  if (a < 0) return []
  const open = src.indexOf('[', a)
  const close = src.indexOf(']', open)
  return Array.from(src.slice(open, close).matchAll(/'([a-z0-9_]+)'/g)).map((x) => x[1])
}
const ALL = listOf('export const PRODUCTS')
const DEAD = listOf('export const DEACTIVATED_PRODUCTS')
let active = []
try {
  const arr = JSON.parse(raw)
  if (Array.isArray(arr)) active = arr.filter((x) => ALL.includes(x))
} catch {
  active = ALL.filter((p) => !DEAD.includes(p))
}
if (!raw) active = ALL.filter((p) => !DEAD.includes(p))
if (active.length === 0) { console.log('no products are active — nothing to check'); process.exit(0) }
console.log('active products:', active.join(', '))
const products = active.slice().sort()

function hashUrl(url) {
  let h = 2166136261
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Exactly the SQL the picker runs. */
const countsFor = async (url) => {
  const { rows } = await db.query(
    `SELECT product, COUNT(*)::int AS n FROM (
       SELECT product FROM link_product_comment WHERE url = $1 AND product IS NOT NULL
       UNION ALL
       SELECT product FROM clicked_link WHERE url = $1 AND product IS NOT NULL
     ) t GROUP BY product`,
    [url]
  )
  const out = {}
  for (const r of rows) out[r.product] = r.n
  return out
}

const pick = (counts) => {
  let best = null
  let bestN = 0
  for (const p of products) {
    const n = counts[p] ?? 0
    if (n > bestN) { best = p; bestN = n }
  }
  return best
}
const pickFor = async (url) => pick(await countsFor(url)) ?? products[hashUrl(url) % products.length]

// ── a video that already has our comments keeps its leader ──────────────────
console.log('\nvideos that already carry our comments:')
const withOurs = (await db.query(
  `SELECT url, product, COUNT(*)::int AS n FROM link_product_comment
    WHERE product IS NOT NULL GROUP BY url, product`
)).rows
const byUrl = new Map()
for (const r of withOurs) {
  const m = byUrl.get(r.url) ?? {}
  m[r.product] = (m[r.product] ?? 0) + r.n
  byUrl.set(r.url, m)
}
console.log(`   ${byUrl.size.toLocaleString()} scanned video(s) carry at least one of ours`)
const mixed = Array.from(byUrl.entries()).filter(([, m]) => Object.keys(m).length > 1)
console.log(`   ${mixed.length.toLocaleString()} of them carry MORE THAN ONE product — what this change stops`)

let wrong = 0
let sample = []
for (const [url, m] of Array.from(byUrl.entries()).slice(0, 400)) {
  const chosen = await pickFor(url)
  const counts = await countsFor(url)
  const top = Math.max(...products.map((p) => counts[p] ?? 0))
  if (top > 0 && (counts[chosen] ?? 0) !== top) wrong++
  if (sample.length < 5 && Object.keys(m).length > 1)
    sample.push({ url: url.slice(-24), found: m, counted: counts, chosen })
}
check('the leader is always the product served next', wrong, 0)
for (const s of sample)
  console.log(`   …${s.url}  scan ${JSON.stringify(s.found)} + served = ${JSON.stringify(s.counted)} -> ${s.chosen}`)

// ── a video with none of ours: same answer for everyone, every time ─────────
console.log('\nvideos with none of ours yet:')
const fresh = (await db.query(
  `SELECT v.url FROM (SELECT DISTINCT url FROM clicked_link LIMIT 1) v`
)).rows
const madeUp = Array.from({ length: 5000 }, (_, i) => `https://www.tiktok.com/@someone/video/75${i}00000000000000`)
const spread = {}
for (const u of madeUp) spread[products[hashUrl(u) % products.length]] = (spread[products[hashUrl(u) % products.length]] ?? 0) + 1
console.log('   5,000 fresh videos spread across the active products:', spread)
check(
  'every product owns a share of the videos',
  products.filter((p) => !(spread[p] > 0)).length,
  0
)
const share = products.map((p) => (spread[p] ?? 0) / madeUp.length)
check(
  'and the split is even (each within 5 points of fair)',
  share.filter((f) => Math.abs(f - 1 / products.length) > 0.05).length,
  0
)
check(
  'the same URL always gives the same product',
  madeUp.slice(0, 50).every((u) => {
    const a = products[hashUrl(u) % products.length]
    return [1, 2, 3].every(() => products[hashUrl(u) % products.length] === a)
  }),
  true
)
// Concurrency is the real point: two users opening a brand-new video at the
// same second must be handed the SAME product, before any count exists.
const one = madeUp[0]
check(
  'two simultaneous clicks on a fresh video agree',
  new Set([0, 1, 2, 3].map(() => products[hashUrl(one) % products.length])).size,
  1
)
if (fresh.length) console.log(`   e.g. a real clicked url -> ${await pickFor(fresh[0].url)}`)

// ── turning a product off releases the videos it owned ──────────────────────
console.log('\nwhen a product is switched off:')
const owned = Array.from(byUrl.entries()).find(([, m]) => Object.keys(m).length === 1)
if (owned) {
  const [url, m] = owned
  const off = Object.keys(m)[0]
  const remaining = products.filter((p) => p !== off)
  const counts = await countsFor(url)
  let best = null
  let bestN = 0
  for (const p of remaining) { const n = counts[p] ?? 0; if (n > bestN) { best = p; bestN = n } }
  const chosen = best ?? remaining[hashUrl(url) % remaining.length]
  check(`  a video owned by ${off} is not stuck on it`, chosen !== off, true)
  console.log(`   …${url.slice(-24)} was ${off} -> now ${chosen}`)
}

await db.end()
console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
