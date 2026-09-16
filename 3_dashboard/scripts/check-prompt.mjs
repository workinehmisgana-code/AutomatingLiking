// Are the comment-generation prompts short, and do they say what is true?
//
// They grew by accretion and had drifted from the code that enforces them: the
// naive-user rule existed twice with two different banned-word lists, neither
// matching the filter; the audience prompt described the product in exactly the
// words its own rule forbids. A prompt that contradicts its filter produces
// batches the filter throws away.
//
// This renders every voice of both prompts and checks them against the filters
// in lib/commentGen.
//
//   node scripts/check-prompt.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

const promptSrc = readFileSync(new URL('../lib/commentPrompt.ts', import.meta.url), 'utf8')
const genSrc = readFileSync(new URL('../lib/commentGen.ts', import.meta.url), 'utf8')

/** Every backtick string in a file — roughly, the text that reaches the model. */
const literals = (src) => {
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return [...body.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join(' ')
}

const VOICES = ['question', 'curious', 'recommendation', 'informational']

console.log('size:')
const text = literals(promptSrc)
const tokens = Math.round(text.length / 4)
console.log(`   lib/commentPrompt.ts holds ~${text.length} characters of prompt (~${tokens} tokens)`)
check('  it fits in a reasonable prompt (under 1,200 tokens)', tokens < 1200, true)

console.log('\nsaid once, not twice:')
// The naive-user rule lived in two places with two different banned lists.
check('  "WHO YOU ARE" appears exactly once', (promptSrc.match(/WHO YOU ARE/g) || []).length, 1)
check('  the audience prompt no longer writes its own background',
  /is an AI humanizer website/.test(genSrc), false)
check('  the audience prompt is assembled in the pure module, not in commentGen',
  /const system = buildAudiencePrompt\(/.test(genSrc), true)
const audBlock =
  promptSrc.split('export function buildAudiencePrompt')[1]?.split('export function buildSystemPrompt')[0] ?? ''
for (const piece of ['productBackground(product)', 'NAIVE_VOICE', 'voiceShapeRule(', 'outputRules(']) {
  check(`  the audience prompt includes ${piece}`, audBlock.includes(piece), true)
}
check('  no stray inline separator remains', /'\n\n' \+/.test(promptSrc), false)

console.log('\nthe prompt does not use the words its own rule bans:')
// Only what REACHES THE MODEL counts. A code comment quoting the phrase it is
// there to prevent is not the prompt using it — the first version of this check
// scanned whole files and failed on exactly that.
const sent = literals(promptSrc) + ' ' + literals(genSrc)
const banned = ['bypasses every', 'the best humanizer', 'at 0% AI', 'the output comes back']
for (const phrase of banned) {
  check(`  no "${phrase}"`, sent.includes(phrase), false)
}

console.log('\nevery voice asks for what the filter requires:')
// sanitize() rejects a non-question under these two voices. If the prompt does
// not ask for one, every line is thrown away — which is exactly what happened
// to the curious voice on the audience path.
for (const voice of VOICES) {
  const needsQuestion = voice === 'question' || voice === 'curious'
  // The rule text for this voice, pulled out of the switch.
  const block = promptSrc.split(`case '${voice}':`)[1]?.split('case ')[0] ?? ''
  const asks = /ending in "\?"|ends in "\?"/.test(block) || (!needsQuestion && true)
  check(`  ${voice}: asks for a question = ${needsQuestion}`, needsQuestion ? asks : true, true)
}
// outputRules adds the "?" requirement for both question voices.
check('  outputRules requires "?" for both question voices',
  /voice === 'question' \|\| style\.voice === 'curious'/.test(promptSrc), true)

console.log('\nthe question voice asks for comparisons, and the filter allows them:')
check('  the prompt gives a compare shape',
  /how does this compare to/.test(promptSrc), true)
check('  COMPARISON is only applied to the curious voice',
  /voice === 'curious' && COMPARISON\.test/.test(genSrc), true)
check('  SELF_DOUBT is applied to both question voices',
  /SELF_DOUBT\.test\(s\)\) continue/.test(genSrc), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
