// Mixing a second voice into every audience at once.
//
// Regenerate REPLACES a set, which is what you want while tuning one voice and
// wrong once it is right: a comment section where every line has the same shape
// reads as one person with several accounts. Adding a batch keeps what is there
// and layers another voice on top — and the useful unit is all three audiences,
// since all three are served.
//
// The two things that make it worth trusting:
//
//   * it APPENDS, never replaces — nothing already generated is lost;
//   * it DEDUPES against what is stored, on the same key sanitize() uses within
//     a batch, so pressing twice on one voice does not double the set.
//
//   node scripts/check-add-batch.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const ui = read('components/AdminProductComments.tsx')
const gen = read('lib/commentGen.ts')
const api = read('app/api/admin/comments/route.ts')

console.log('the page offers it for all three audiences at once:')
check('  there is a button for it', /onClick=\{addBatchToAll\}/.test(ui), true)
check('  it names the voice it will use', /\+ Add a \$\{voice\} batch to all three/.test(ui), true)
check('  it walks every audience', /for \(const \{ category \} of perCategory\)/.test(ui), true)
check('  asking each to append', /\{ product, category, append: true \}/.test(ui), true)
check('  saving the settings first', /if \(!\(await commitBand\(\)\)\) return/.test(ui), true)
check(
  '  with its own busy state, not Regenerate’s',
  /audBusy === 'add-all' \? 'Adding/.test(ui),
  true
)
check('  one audience can still be topped up alone', /onClick=\{\(\) => addAudienceBatch\(category\)\}/.test(ui), true)

console.log('\nthe api routes an append to the named audience:')
check('  append requires an audience', /if \(append\) \{[\s\S]{0,400}isLinkCategory\(category\)/.test(api), true)
check('  and calls appendToCategory', /appendToCategory\(product, category\)/.test(api), true)

console.log('\nappending keeps what is already stored:')
const fn = gen.slice(gen.indexOf('export async function appendToCategory'))
const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
check('  it reads the stored set first', /getCategoryComments\(product, category\)/.test(body), true)
check('  merges rather than replaces', /const merged = \[\.\.\.stored, \.\.\.added\]/.test(body), true)
check('  saves the merge', /saveCategoryComments\(product, category, merged\)/.test(body), true)
check('  and reports what was actually new', /return \{ added: added\.length, total: merged\.length \}/.test(body), true)

console.log('\nthe dedupe rule, run over a worked example:')
// The same key the function uses: text without emoji, lowercased.
const stripEmoji = (t) => t.replace(/[\p{Extended_Pictographic}️]/gu, '').trim()
const key = (t) => stripEmoji(t).toLowerCase()
check('  it is the stored key', /const key = \(t: string\) => stripEmoji\(t\)\.toLowerCase\(\)/.test(body), true)

const stored = ['this one saved me 🙌', 'Mine passes now']
const fresh = ['This one saved me', 'mine passes now 😅', 'genuinely did not expect it to work']
const seen = new Set(stored.map(key))
const added = []
for (const c of fresh) {
  const k = key(c)
  if (seen.has(k)) continue
  seen.add(k)
  added.push(c)
}
check('  an emoji does not make a line new', added.length, 1)
check('  nor does capitalisation', added, ['genuinely did not expect it to work'])
check('  the merge grows by exactly that', [...stored, ...added].length, 3)

// Pressing the same voice twice: the second press adds nothing.
const again = ['This one saved me', 'mine passes now']
const second = again.filter((c) => !seen.has(key(c)))
check('  a second press on one voice adds nothing', second, [])

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
