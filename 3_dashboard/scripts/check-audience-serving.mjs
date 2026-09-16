// Users get "Comments by audience" comments, and nothing else.
//
// Every comment a user pastes comes from one function — serveCommentForUrl,
// which both /api/app/click and /api/clicks call. It used to read
// generated_comments: the audience-NEUTRAL set. So the whole audience split
// existed in the admin and reached nobody. It now reads category_comments for
// the link's own audience, and a link with no category gets the 'competitors'
// set.
//
// Checked here:
//
//   1. the RULE, read out of the source — no neutral set on the serving path,
//      and the fallback really is competitors;
//   2. the DATA, read out of the database — every active product has a stocked
//      set for every audience, so the "nothing generated yet" escape hatch
//      inside getFreshCategoryComments never fires;
//   3. the REACH — how many real links land in each audience, including the
//      ones with no category that the fallback now covers.
//
//   node scripts/check-audience-serving.mjs
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

// ── 1. the rule ────────────────────────────────────────────────────────────
const serve = read('lib/serveComment.ts')
const config = read('lib/config.ts')
console.log('the serving path reads audience comments only:')
check('  it calls getFreshCategoryComments', /getFreshCategoryComments\(product, category\)/.test(serve), true)
check('  and never the neutral getFreshComments', /getFreshComments/.test(serve), false)
check('  the category comes from the link', /getLinkCategory\(url\)/.test(serve), true)
check(
  '  an uncategorised link falls back',
  /isLinkCategory\(stored\) \? stored : FALLBACK_COMMENT_CATEGORY/.test(serve),
  true
)
check(
  '  and the fallback is competitors',
  /FALLBACK_COMMENT_CATEGORY: LinkCategory = 'competitors'/.test(config),
  true
)

const webRoute = read('app/api/comments/route.ts')
const appRoute = read('app/api/app/comments/route.ts')
console.log('\nthe pools the two clients cache are audience pools too:')
check('  web: no neutral set', /getFreshComments\b/.test(webRoute), false)
check('  web: one pool per audience', /byCategory\[category\] = /.test(webRoute), true)
check('  app: no neutral set', /getFreshComments\b/.test(appRoute), false)
check(
  '  both flat pools are the fallback audience',
  [webRoute, appRoute].every((r) => /byCategory\[FALLBACK_COMMENT_CATEGORY\] \?\? \[\]/.test(r)),
  true
)

const dash = read('components/Dashboard.tsx')
console.log('\nthe web page picks from the audience of the link it is opening:')
check('  the pick is per video', /const pool = poolFor\(v\)/.test(dash), true)
check('  by the video’s own category', /v\.category \? pools\[v\.category\]/.test(dash), true)
check('  falling back to competitors', /pools\[FALLBACK_COMMENT_CATEGORY\]/.test(dash), true)
check('  and the feed carries the category', /category: feedCategories\[String\(v\.url\)\] \?\? null/.test(read('app/page.tsx')), true)

// ── 2. the data ────────────────────────────────────────────────────────────
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
const sets = new Map()
for (const r of await q(
  'SELECT product, category, jsonb_array_length(comments) n FROM category_comments'
)) {
  sets.set(`${r.product}/${r.category}`, Number(r.n))
}

console.log(`\nevery active product can speak to every audience (${active.join(', ')}):`)
const empty = []
for (const p of active)
  for (const c of CATEGORIES) if (!(sets.get(`${p}/${c}`) > 0)) empty.push(`${p}/${c}`)
check('  no empty (product, audience) pair', empty, [])
for (const p of active)
  console.log(
    `   ${p.padEnd(14)} ` +
      CATEGORIES.map((c) => `${c} ${String(sets.get(`${p}/${c}`) ?? 0).padStart(3)}`).join('  ')
  )

// The neutral set is what users USED to get. If it were identical to the
// audience sets this change would be cosmetic — it isn't.
const neutral = new Map()
for (const r of await q('SELECT product, comments FROM generated_comments'))
  neutral.set(r.product, new Set((r.comments ?? []).map((c) => String(c).trim())))
const catTexts = new Map()
for (const r of await q('SELECT product, category, comments FROM category_comments'))
  catTexts.set(`${r.product}/${r.category}`, (r.comments ?? []).map((c) => String(c).trim()))

console.log('\nhow different that actually is, per product:')
for (const p of active) {
  const n = neutral.get(p) ?? new Set()
  const all = CATEGORIES.flatMap((c) => catTexts.get(`${p}/${c}`) ?? [])
  const shared = all.filter((t) => n.has(t)).length
  console.log(
    `   ${p.padEnd(14)} ${all.length} audience comments, ${shared} of them also in the old neutral set`
  )
}

// ── 3. the reach ───────────────────────────────────────────────────────────
const catCounts = Object.fromEntries(
  (await q('SELECT category, count(*)::int n FROM link_category GROUP BY category')).map((r) => [
    r.category,
    r.n,
  ])
)
const categorised = Object.values(catCounts).reduce((a, b) => a + b, 0)
await db.end()

const { list } = await import('@vercel/blob')
const { blobs } = await list({ prefix: 'videos.json' })
const poolUrls = (
  await (
    await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
  ).json()
).filter((v) => v?.url).length

console.log('\nwhich audience each link is served from:')
for (const c of CATEGORIES)
  console.log(`   ${c.padEnd(14)} ${(catCounts[c] ?? 0).toLocaleString()}`)
const uncategorised = Math.max(0, poolUrls - categorised)
console.log(`   (no category)  ${uncategorised.toLocaleString()} → served from competitors`)
check('  every link in the pool is covered', categorised + uncategorised, poolUrls)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
