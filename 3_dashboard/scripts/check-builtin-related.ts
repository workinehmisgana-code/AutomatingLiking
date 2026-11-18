// A built-in genre's "what counts as related" can be edited and reset: save an
// edit for slides, see it in force, reset it, see the code default back.
// Leaves the stored rule as it found it.
//   node scripts/run-ts-check.mjs scripts/check-builtin-related.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const store = await import('../lib/genreStore')
  const { GENRE_COPY } = await import('../lib/prompts')
  const { getAppState, setAppState } = await import('../lib/db')
  await store.ensureGenreRegistry(true)
  const before = await getAppState('builtin_genre_related').catch(() => null)
  const code = { ...GENRE_COPY.slides.related }
  let bad = 0
  const ok = (c: boolean, what: string) => {
    console.log(`  ${c ? 'ok    ' : 'FAILED'} ${what}`)
    if (!c) bad++
  }
  try {
    const r = await store.saveGenreRelated('slides', 'about slide decks: test topic one, test topic two', ['Test Word', 'deck'])
    ok(r.ok, 'saving an edit to the built-in slides genre is accepted')
    ok(GENRE_COPY.slides.related.subject.includes('test topic one'), 'the edit is in force')
    ok(GENRE_COPY.slides.related.keywords.includes('testword'), 'keywords are normalised')
    ok(store.builtinRelatedIsCustom('slides'), 'marked as edited')
    ok(GENRE_COPY.humanizer.related.subject !== GENRE_COPY.slides.related.subject, 'other genres untouched')
    await store.resetBuiltinRelated('slides')
    ok(GENRE_COPY.slides.related.subject === code.subject, 'reset brings the code default back')
    ok(!store.builtinRelatedIsCustom('slides'), 'no longer marked as edited')
  } finally {
    if (before !== null) await setAppState('builtin_genre_related', before)
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
