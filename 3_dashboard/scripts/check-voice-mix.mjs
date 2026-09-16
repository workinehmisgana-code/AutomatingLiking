// A set built from several voices is rebuilt from several voices.
//
// "+ Add a question batch to all three" is how a comment section stops reading
// as one person with several accounts. It was a one-off: the voice was used and
// forgotten, so the next regeneration — the button, or the nightly cron —
// rebuilt each set from whatever single voice happened to be selected, and
// every mix an admin had built was flattened overnight with nothing to show
// what had happened.
//
// The voices are now recorded ON the set, and a regeneration makes one batch
// per recorded voice and merges them. The rules that matter:
//
//   * adding a batch records its voice, even when the batch added no new lines
//     — the voice was still asked for;
//   * regenerating rebuilds from the recorded mix, not from the current voice;
//   * a set with NO recorded mix behaves exactly as before (current voice) and
//     records it, so nothing changes until someone builds a mix;
//   * only voices that actually produced something are kept, so a permanently
//     broken voice does not sit in the recipe forever;
//   * the nightly cron goes through the same function, or the whole thing is
//     undone once a day.
//
// Runs against the real database on a throwaway product row, then cleans up.
//
//   node scripts/check-voice-mix.mjs
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

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const q = async (sql, p = []) => (await db.query(sql, p)).rows

const P = '__voicemix_check__'
const C = 'competitors'

try {
  await db.query('DELETE FROM category_comments WHERE product = $1', [P])

  console.log('the column exists and defaults to no mix:')
  const col = (
    await q(
      `SELECT data_type, column_default, is_nullable FROM information_schema.columns
        WHERE table_name = 'category_comments' AND column_name = 'voices'`
    )
  )[0]
  check('  it is there', !!col, true)
  check('  as jsonb', col?.data_type, 'jsonb')
  check('  defaulting to empty', String(col?.column_default ?? '').includes("'[]'"), true)
  check('  and never null', col?.is_nullable, 'NO')

  // saveCategoryComments(..., voices) — the insert path.
  await db.query(
    `INSERT INTO category_comments (product, category, comments, voices, generated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, now())`,
    [P, C, JSON.stringify(['a one', 'a two']), JSON.stringify(['recommendation'])]
  )
  const mix = async () =>
    (await q('SELECT voices FROM category_comments WHERE product = $1 AND category = $2', [P, C]))[0]
      ?.voices ?? []
  console.log('\na freshly generated set records the voice it used:')
  check('  one voice', await mix(), ['recommendation'])

  // addCategoryVoice — appending a batch in a second voice.
  const add = (v) =>
    db.query(
      `UPDATE category_comments
          SET voices = CASE WHEN voices @> $3::jsonb THEN voices ELSE voices || $3::jsonb END
        WHERE product = $1 AND category = $2`,
      [P, C, JSON.stringify([v])]
    )
  await add('question')
  console.log('\nadding a question batch adds it to the recipe:')
  check('  both, in the order added', await mix(), ['recommendation', 'question'])
  await add('question')
  check('  adding the same voice twice records it once', await mix(), ['recommendation', 'question'])
  await add('curious')
  check('  a third joins the end', await mix(), ['recommendation', 'question', 'curious'])

  // saveCategoryComments with voices OMITTED must not wipe the recipe.
  await db.query(
    `INSERT INTO category_comments (product, category, comments, voices, generated_at)
     VALUES ($1, $2, $3::jsonb, COALESCE($4::jsonb, '[]'::jsonb), now())
     ON CONFLICT (product, category) DO UPDATE SET
       comments = EXCLUDED.comments,
       voices = COALESCE($4::jsonb, category_comments.voices),
       generated_at = now(), locked_at = NULL`,
    [P, C, JSON.stringify(['edited']), null]
  )
  console.log('\nsaving comments WITHOUT a mix leaves the recipe alone:')
  check('  still all three', await mix(), ['recommendation', 'question', 'curious'])

  // And with voices given, it replaces.
  await db.query(
    `INSERT INTO category_comments (product, category, comments, voices, generated_at)
     VALUES ($1, $2, $3::jsonb, COALESCE($4::jsonb, '[]'::jsonb), now())
     ON CONFLICT (product, category) DO UPDATE SET
       comments = EXCLUDED.comments,
       voices = COALESCE($4::jsonb, category_comments.voices),
       generated_at = now(), locked_at = NULL`,
    [P, C, JSON.stringify(['rebuilt']), JSON.stringify(['question', 'curious'])]
  )
  check('  a regeneration records what actually worked', await mix(), ['question', 'curious'])
} finally {
  await db.query('DELETE FROM category_comments WHERE product = $1', [P])
  await db.end()
}

// ── the generator honours it ───────────────────────────────────────────────
const gen = read('lib/commentGen.ts')
const dbSrc = read('lib/db.ts')
const api = read('app/api/admin/comments/route.ts')
const ui = read('components/AdminProductComments.tsx')
const cron = read('app/api/cron/comments/route.ts')

console.log('\nregeneration rebuilds the mix, not the current voice:')
check('  it reads the recorded voices', /const recorded = \(stored\?\.voices \?\? \[\]\)\.filter\(isCommentVoice\)/.test(gen), true)
check(
  '  falling back to the current voice when there is no mix',
  /const voices: CommentVoice\[\] = recorded\.length \? recorded : \[style\.voice\]/.test(gen),
  true
)
check('  one batch per voice', /for \(const voice of voices\) \{/.test(gen), true)
check('  each in ITS voice, not the saved one', /const styled: CommentStyle = \{ \.\.\.style, voice \}/.test(gen), true)
check('  merged and deduped across voices', /if \(seen\.has\(k\)\) continue/.test(gen), true)
check('  and only the voices that worked are kept', /saveCategoryComments\(product, category, out, usedVoices\)/.test(gen), true)
// One voice failing must not lose the others, and a total failure must throw
// rather than quietly write an empty set.
check('  a failing voice does not lose the rest', /lastError = e\s*\n\s*continue/.test(gen), true)
check('  and a total failure throws', /if \(lastError\) throw lastError/.test(gen), true)

console.log('\nadding a batch records its voice:')
check('  on the set', /addCategoryVoice\(product, category, style\.voice\)/.test(gen), true)
check('  appending only, never replacing', /voices @> \$3::jsonb THEN voices/.test(dbSrc), true)

console.log('\nthe nightly job goes through the same function:')
check('  cron -> regenerateCategoryProducts', /regenerateCategoryProducts/.test(cron), true)
check('  which calls regenerateCategory', /regenerateCategory\(p, c\)/.test(gen), true)

console.log('\nthe admin can see and edit the recipe:')
check('  the page is sent the voices', /voices: row\?\.voices \?\? \[\]/.test(read('app/admin/comments/[product]/page.tsx')), true)
check('  each panel shows what it is rebuilt from', /rebuilt from/.test(ui), true)
check('  a voice can be dropped', /async function dropVoice/.test(ui), true)
check('  but never the last one', /A set needs at least one voice/.test(ui), true)
check('  the api refuses an empty recipe too', /A set needs at least one voice\./.test(api), true)
// The sentence wraps across two comment lines, so match it whitespace-loosely
// rather than asserting a line break that is only there for width.
check(
  '  and says the text is left alone',
  /The comments already[\s\S]{0,60}?written are left alone/.test(api),
  true
)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
