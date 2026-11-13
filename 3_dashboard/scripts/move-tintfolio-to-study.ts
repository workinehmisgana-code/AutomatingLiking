// Move tintfolio from Humanizer to the Study helper genre: add it to the saved
// study-helper genre with study-helper base comments, then rebuild its comment
// sets (the stored ones were written for humanizer videos).
//
//   node scripts/run-ts-check.mjs scripts/move-tintfolio-to-study.ts           (dry run)
//   node scripts/run-ts-check.mjs scripts/move-tintfolio-to-study.ts --save    (save + regenerate)
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

export const SEEDS = [
  'tintfolio explained the topic i was stuck on better than my textbook',
  'i revise with tintfolio before every test now, my grades actually went up',
  'tintfolio turned my lecture notes into practice questions and half of them came up',
  'i was lost in biology until tintfolio broke it down for me',
  'tintfolio quizzes me on my own notes, way better than rereading them',
  'had an exam in the morning and tintfolio got me through the whole chapter',
  'tried a few study apps, tintfolio is the one i still use',
  'tintfolio is how i finally understood statistics this semester',
  'i do tintfolio questions on the bus to school, it adds up',
  'my friends asked how i passed, it was tintfolio and a lot of coffee',
  'tintfolio made revising for finals feel way less scary',
  'i used to cram, now i just go through tintfolio every night',
]

async function main(): Promise<void> {
  const save = process.argv.includes('--save')
  const store = await import('../lib/genreStore')
  await store.ensureGenreRegistry(true)
  const g = (await store.listCustomGenres()).find((x) => x.id === 'study-helper')
  if (!g) throw new Error('the study-helper genre is not saved')
  const has = g.products.some((p) => p.id === 'tintfolio')
  console.log(`study-helper products now: ${g.products.map((p) => p.id).join(', ')}${has ? '' : ' (+ tintfolio)'}`)
  if (!save) {
    console.log('dry run — pass --save to store it and regenerate its comment sets')
    process.exit(0)
  }
  const next = {
    ...g,
    products: has ? g.products : [...g.products, { id: 'tintfolio', site: '' }],
    seeds: { ...g.seeds, tintfolio: SEEDS },
  }
  const r = await store.saveCustomGenre(next as never, false)
  if ('problems' in r) {
    console.log('NOT SAVED:\n  ' + r.problems.join('\n  '))
    process.exit(1)
  }
  const cfg = await import('../lib/config')
  console.log('saved; tintfolio genre is now', cfg.genreOfProduct('tintfolio'), '· written as', cfg.productWords('tintfolio'))

  // Its comment style was set for humanizer videos (3–8 word questions with
  // emoji, "tint folio"); give it the study-helper style qoloclass uses.
  const db0 = await import('../lib/db')
  await db0.setProductWordBand('tintfolio', { min: 6, max: 12 })
  await db0.setProductCommentStyle('tintfolio', {
    emoji: false,
    splitBrand: false,
    quoteBrand: false,
    voice: 'recommendation',
  } as never)
  // Study helper serves only the generic audience, so the humanizer-era
  // competitors / ai_detector sets can never be reached again: drop them.
  const { pool } = db0 as unknown as { pool: import('pg').Pool }
  const del = await pool.query(
    `DELETE FROM category_comments WHERE product = 'tintfolio' AND category IN ('competitors', 'ai_detector')`
  )
  console.log(`dropped ${del.rowCount} humanizer-era set(s)`)

  // The voice passed explicitly: a stored set remembers the voices it was made
  // with ('question', from its humanizer days) and would otherwise reuse them.
  const { regenerateCategory } = await import('../lib/commentGen')
  console.log('generic:', await regenerateCategory('tintfolio' as never, 'generic' as never, ['recommendation']))
  const { getCategoryComments } = await import('../lib/db')
  for (const c of ['competitors', 'ai_detector', 'generic']) {
    const s = await getCategoryComments('tintfolio', c)
    console.log(`\n${c}: ${s?.comments.length ?? 0}`)
    for (const t of (s?.comments ?? []).slice(0, 6)) console.log('  ' + t)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
