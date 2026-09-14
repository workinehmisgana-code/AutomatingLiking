// Does the prompt shown in the editor match the one that is actually sent?
//
// The editor rebuilds it in the BROWSER as the settings change, so there is now
// one function used from two places. The risk is not that it is wrong today —
// it is that someone later edits the wording in one and not the other, and the
// box quietly shows a prompt that is not what Groq receives.
//
// So this checks the arrangement rather than the words: exactly one definition,
// in a module the browser can load, imported by both sides, and it changes when
// the settings change.
//
//   node scripts/check-prompt-live.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const prompt = read('lib/commentPrompt.ts')
const gen = read('lib/commentGen.ts')
const ui = read('components/AdminProductComments.tsx')
const route = read('app/api/admin/comments/prompt/route.ts')

console.log('one definition, in one place:')
check('defined in lib/commentPrompt', /export function buildSystemPrompt/.test(prompt), true)
check('and NOT redefined in commentGen', /function buildSystemPrompt/.test(gen), false)
check('and NOT redefined in the component', /function buildSystemPrompt/.test(ui), false)

console.log('\nboth sides import that one:')
check('the generator does', /from '\.\/commentPrompt'/.test(gen), true)
check('the admin page does', /from '@\/lib\/commentPrompt'/.test(ui), true)
check('the API route does', /from '@\/lib\/commentPrompt'/.test(route), true)

console.log('\nthe browser can actually load it:')
// Anything that pulls in pg, the blob client or the Groq client cannot run in a
// browser — importing one would break the page at build time, not at review.
const imports = [...prompt.matchAll(/^import .*?from '([^']+)'/gm)].map((m) => m[1])
check('it imports only config', imports, ['./config'])
for (const bad of ['./db', './groq', '@vercel/blob', 'pg']) {
  check(`no ${bad}`, prompt.includes(`'${bad}'`), false)
}

console.log('\nit responds to every setting the page can change:')
for (const [name, token] of [
  ['voice', 'style.voice'],
  ['word band', 'band.min'],
  ['emoji', 'style.emoji'],
  ['brand spelling', 'style.splitBrand'],
]) check(`  ${name}`, prompt.includes(token), true)

console.log('\nthe editor rebuilds on each of them:')
const deps = (ui.match(/\[product, min, max, wordMin, wordMax, emoji, splitBrand, quoteBrand, voice\]/) || [])[0]
check('the memo lists every switch', !!deps, true)
check('typing stops it following', /onChange=\{\(e\) => setPromptEdit\(e\.target\.value\)\}/.test(ui), true)
check('and a saved prompt is flagged as not following', /overrideStale/.test(ui), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
