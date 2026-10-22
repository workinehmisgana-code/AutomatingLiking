// Does changing the voice actually change anything?
//
// It did not, in two separate ways, and both of them looked like the setting was
// broken rather than unsaved:
//
//  1. THE CONTROL NEVER SAVED. The voice selector and the two style checkboxes
//     only set React state. The one thing that wrote them to the database was a
//     button labelled "Save range", plus a regeneration — so changing the voice
//     updated the live preview, looked done, and was gone on the next load. Of
//     six products, exactly one had a voice saved from that control.
//
//  2. THE SET IGNORED IT ANYWAY. regenerateCategory rebuilt from the voices
//     RECORDED ON THE SET, falling back to the product's voice only when that
//     list was empty — so "set informational, press Regenerate" produced
//     questions. Correct by the rule and indefensible as behaviour.
//
//     The rule was right about the NIGHTLY rebuild, which has no dropdown to read
//     and must not flatten a mix built by hand, and wrong about a person pressing
//     the button with the selector in front of them. So the page now sends the
//     selected voice with the request and the cron sends nothing.
//
//   node scripts/check-voice-setting.mjs
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
const ui = read('components/AdminProductComments.tsx')
const gen = read('lib/commentGen.ts')
const route = read('app/api/admin/comments/settings/route.ts')

console.log('the control saves the moment it is changed:')
check('  there is a saver for the style alone', /async function commitStyle/.test(ui), true)
check('  the voice selector calls it', /void commitStyle\(\{ voice: v \}\)/.test(ui), true)
check('  and the checkboxes too', /void commitStyle\(\n\s*label === 'Emoji'/.test(ui), true)
check('  it sends the whole settings row', /quoteBrand,\n\s*voice: patch\.voice \?\? voice,/.test(ui), true)
check('  and shows what the server stored', /if \(isCommentVoice\(d\.voice\)\) setVoice\(d\.voice\)/.test(ui), true)
check('  the bug is written down', /THIS WAS THE BUG/.test(ui), true)
// The word range keeps its explicit save: two numbers being typed must not be
// stored on every keystroke.
check('  the band still saves explicitly', /'Save word range'/.test(ui), true)

console.log('\nand the endpoint keeps what it is not told about:')
check('  an absent flag means unchanged', /leave it alone/.test(route), true)
check('  the voice is validated', /isCommentVoice\(body\?\.voice\)/.test(route), true)

console.log('\nand pressing Regenerate uses the voice on screen:')
const apiRoute = read('app/api/admin/comments/route.ts')
check('  the generator takes an override', /override\?: readonly string\[\]/.test(gen), true)
check('  which wins over the recipe', /asked\.length\n\s*\? asked/.test(gen), true)
check('  and the recipe still wins over the default', /: recorded\.length/.test(gen), true)
check('  the page sends the selection', /voices: \[voice\] \}\),/.test(ui), true)
check('  for all three audiences too', /this is a person pressing Regenerate/.test(ui), true)
check('  and says which voice it wrote', /\$\{voice\} comments/.test(ui), true)
// ONE FIELD, TWO REQUESTS. `voices` used to mean "edit the recipe and generate
// nothing"; a Regenerate carrying it would have silently generated nothing at all.
check('  a recipe edit says so explicitly', /recipeOnly/.test(apiRoute), true)
check('  and the callers set it', ui.match(/recipeOnly: true/g)?.length, 2)
check('  the two meanings are written down', /carries two different requests/.test(apiRoute), true)
// The cron keeps the recipe, which is what the recipe was for.
check('  the cron passes no override', /await regenerateCategory\(p, c\)/.test(gen), true)
check('  and the reason is written down', /The nightly cron\n \* passes nothing/.test(gen), true)

console.log('\nand the recipe row says what it still decides:')
check('  the nightly job, not this press', /the nightly rebuild uses that/.test(ui), true)
check('  with one click to change that too', /use \{voice\} nightly too/.test(ui), true)
check('  which writes no comments', /Writes no comments/.test(ui), true)
check('  and says the old ones stay', /stay until you regenerate/.test(ui), true)
// A mix is worth a question before it is thrown away.
check('  replacing a mix asks first', /Regenerate it in \$\{voice\} alone\?/.test(ui), true)

// ── what the database says right now ───────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const { rows: set } = await db
  .query(
    `SELECT product, voice, updated_at FROM product_comment_setting ORDER BY product`
  )
  .catch(() => ({ rows: [] }))
const { rows: sets } = await db
  .query(
    `SELECT product, category, voices,
            (SELECT count(*) FROM jsonb_array_elements_text(comments::jsonb) c
              WHERE c LIKE '%?%')::int questions,
            jsonb_array_length(comments::jsonb)::int n
       FROM category_comments ORDER BY product, category`
  )
  .catch(() => ({ rows: [] }))
const voiceOf = new Map(set.map((r) => [r.product, r.voice]))
console.log('\nper product: the setting, and what its sets will actually rebuild from')
const seen = new Set()
for (const r of sets) {
  if (seen.has(r.product)) continue
  seen.add(r.product)
  const mine = sets.filter((x) => x.product === r.product)
  const recipes = [...new Set(mine.flatMap((x) => x.voices ?? []))]
  const q = mine.reduce((s2, x) => s2 + x.questions, 0)
  const n = mine.reduce((s2, x) => s2 + x.n, 0)
  const setting = voiceOf.get(r.product) ?? '(none saved — defaults to question)'
  const clash = recipes.length && !recipes.includes(setting)
  console.log(
    `   ${r.product.padEnd(13)} setting=${String(setting).padEnd(16)} ` +
      `rebuilds from=${(recipes.join('+') || '(the setting)').padEnd(16)} ` +
      `${q}/${n} stored are questions${clash ? '   <- the NIGHTLY rebuild keeps this voice; pressing Regenerate now uses the setting' : ''}`
  )
}
await db.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
