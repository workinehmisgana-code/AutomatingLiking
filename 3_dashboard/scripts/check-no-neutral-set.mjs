// The audience-neutral comment set is gone.
//
// Comments used to exist twice: one set per product (generated_comments) and one
// per product AND audience (category_comments). The neutral one was what users
// were actually served, which made the audience split decorative; it is now
// removed outright. Every comment in the product comes from an audience set.
//
// Removing a fallback is the risky half. What replaces it:
//
//   * the nightly cron refreshes the AUDIENCE sets, so they do not go stale;
//   * if the product that wins a video has nothing for its audience, the other
//     active products are asked for the SAME audience before giving up — the
//     audience is a property of the video and cannot be substituted, the
//     product is only a preference.
//
// Checked here: the rule in the source, then whether the data can actually
// starve a link.
//
//   node scripts/check-no-neutral-set.mjs
import { readFileSync, existsSync } from 'node:fs'

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

// ── 1. nothing generates, serves or shows the neutral set ──────────────────
// Every file that ever touched it. A name reappearing in any of them is the
// neutral set coming back.
const FILES = [
  'lib/commentGen.ts',
  'lib/serveComment.ts',
  'app/api/comments/route.ts',
  'app/api/app/comments/route.ts',
  'app/api/links/comment/route.ts',
  'app/api/admin/comments/route.ts',
  'app/api/cron/comments/route.ts',
  'app/admin/comments/[product]/page.tsx',
  'components/AdminProductComments.tsx',
]
const GONE = [
  'getFreshComments',
  'regenerateProduct',
  'regenerateProducts',
  'appendToProduct',
  'getGeneratedComments',
  'saveGeneratedComments',
  'deleteGeneratedComment',
]
console.log('no live code path reaches the neutral set:')
for (const name of GONE) {
  const hits = FILES.filter((f) => new RegExp(`\\b${name}\\b`).test(read(f)))
  check(`  ${name}`, hits, [])
}
check(
  '  the admin prompt editor for it is gone too',
  existsSync(new URL('../app/api/admin/comments/prompt/route.ts', import.meta.url)),
  false
)

console.log('\nwhat replaced it:')
const cron = read('app/api/cron/comments/route.ts')
const serve = read('lib/serveComment.ts')
const gen = read('lib/commentGen.ts')
check('  the cron refreshes the audience sets', /regenerateCategoryProducts/.test(cron), true)
check('  and only for active products', /getActiveCommentProducts/.test(cron), true)
check('  serving tries every product for the audience', /for \(const product of order\)/.test(serve), true)
check(
  '  an ungenerated pair returns empty, not neutral',
  /Never generated, and generating it just now did not work either\./.test(gen),
  true
)
check('  a batch can still be added, per audience', /export async function appendToCategory/.test(gen), true)

// ── 2. can the data starve a link? ─────────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

const active = JSON.parse(
  (await q('SELECT active_comment_products v FROM app_state WHERE id = 1'))[0]?.v ?? '[]'
)
const CATEGORIES = ['competitors', 'ai_detector', 'generic']
const sizes = new Map()
for (const r of await q(
  'SELECT product, category, jsonb_array_length(comments) n FROM category_comments'
))
  sizes.set(`${r.product}/${r.category}`, Number(r.n))
await db.end()

const stockedFor = (c) => active.filter((p) => sizes.get(`${p}/${c}`) > 0)

console.log(`\nfor every audience, at least one active product can speak (${active.join(', ')}):`)
for (const c of CATEGORIES) {
  const who = stockedFor(c)
  check(`  ${c.padEnd(12)} ${who.length} of ${active.length} stocked`, who.length > 0, true)
}
const starved = CATEGORIES.filter((c) => stockedFor(c).length === 0)
check('  no audience is unserveable', starved, [])

console.log('\nper product and audience:')
for (const p of active)
  console.log(
    `   ${p.padEnd(14)} ` +
      CATEGORIES.map((c) => `${c} ${String(sizes.get(`${p}/${c}`) ?? 0).padStart(3)}`).join('  ')
  )

// The old neutral rows are left in the table untouched. Nothing reads them, and
// deleting a user's data to prove a point is not an improvement.
console.log('\nthe old rows are left alone in generated_comments — dead, not destroyed.')

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
