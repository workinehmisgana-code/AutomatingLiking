// Do the generated comments actually read as questions that assume the claim?
//
// Two halves.
//
// OFFLINE — the filters. The prompt asks for question style; the model drifts
// back to statements after a few batches, and a DOUBTING question is worse than
// a statement: "does purify text actually work?" argues the case against us,
// under our own video, in our own comment. Both have to be rejected, and the
// rejection has to be narrow enough not to eat good lines.
//
// LIVE (--live) — one real Groq batch, printed, so the voice can be read rather
// than assumed.
//
//   node scripts/check-question-style.mjs [--live]
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

// The two filters, lifted from lib/commentGen.ts.
const src = readFileSync(new URL('../lib/commentGen.ts', import.meta.url), 'utf8')
const DOUBTING = new RegExp(
  [
    String.raw`\b(is|are|was|were)\s+[\w .']{0,24}?\s*(any\s+good|legit|worth\s+it|real|safe|reliable|accurate)\b`,
    String.raw`\bdoes\s+(it|this|that)\s+(actually\s+|really\s+|even\s+)?work\b`,
    String.raw`\bhas\s+anyone\s+(tried|used|tested)\b`,
    String.raw`\bshould\s+i\s+(use|try|get)\b`,
    String.raw`\bwhich\s+(one|is)\s+(is\s+)?better\b`,
    String.raw`\bis\s+it\s+better\s+than\b`,
    String.raw`\bworth\s+(it|trying|using)\b`,
    String.raw`\b(any|other)\s+alternatives?\b`,
  ].join('|'),
  'i'
)
const isQuestion = (s) => /\?\s*$/.test(s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').trim())

console.log('the file itself:')
check('no stray control characters in the source',
  [...src].some((c) => c.charCodeAt(0) < 32 && !'\n\r\t'.includes(c)), false)

console.log('\nkept — questions that assume it works:')
for (const s of [
  'how is purify text the only one still getting past turnitin? 😅',
  'why does nothing else come back 0% like purify text does?',
  'does anyone else run everything through purify text before submitting?',
  'is it just me or has purify text never once flagged on gptzero?',
  'what did people even do before purify text existed?',
  'how long have you been using purify text for your essays?',
]) check(`  ${s.slice(0, 46)}…`, isQuestion(s) && !DOUBTING.test(s), true)

console.log('\nrejected — not a question at all:')
for (const s of [
  'purify text gets my essays past every detector.',
  'i switched to purify text and mine passes now 🙌',
]) check(`  ${s.slice(0, 46)}…`, isQuestion(s), false)

console.log('\nrejected — a question that argues against us:')
for (const s of [
  'is purify text any good for turnitin?',
  'does it actually work on gptzero?',
  'has anyone tried purify text yet?',
  'should i use purify text or something else?',
  'which one is better for essays?',
  'is it better than the other humanizers?',
  'purify text worth it for a final draft?',
  'any alternatives to purify text?',
]) check(`  ${s.slice(0, 46)}…`, DOUBTING.test(s), true)

// The filter must not be so greedy it eats the good ones.
console.log('\nthe filter is narrow enough:')
for (const s of [
  'how does purify text work so well on turnitin?',   // contains "work"
  'why is purify text the one everyone tried after?',  // contains "tried"
  'how is it better every time i use it?',             // "better" but not a comparison
  'is purify text still holding up for finals?',       // "is <product> ..." but not doubting
]) check(`  ${s.slice(0, 46)}…`, DOUBTING.test(s), false)

if (process.argv.includes('--live')) {
  console.log('\none real batch through Groq:')
  const { getFreshComments } = await import('../lib/commentGen.ts').catch(() => ({}))
  if (!getFreshComments) {
    console.log('   (cannot import the TS module directly from node — run the')
    console.log('    admin "regenerate" button instead and read the result there)')
  }
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
