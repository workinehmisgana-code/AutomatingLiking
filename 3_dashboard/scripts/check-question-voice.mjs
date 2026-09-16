// The question voice asks the creator to compare — does the filter let it through?
//
// The voice changed shape: it used to be a rhetorical question that assumed the
// product works, and it is now a question put TO the creator asking them to
// measure what they are showing against ours. That inverts one of the filters —
// comparisons were rejected as "doubting", and they are now the whole point.
//
// What must still be rejected is a question about OUR product's worth. The two
// were one regex; this checks they came apart cleanly.
//
//   node scripts/check-question-voice.mjs
let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

/** Mirrors SELF_DOUBT in lib/commentGen.ts. */
const SELF_DOUBT = new RegExp(
  [
    String.raw`\b(is|are|was|were)\s+[\w .']{0,24}?\s*(any\s+good|legit|worth\s+it|real|safe|reliable|accurate)\b`,
    String.raw`\bdoes\s+(it|this|that)\s+(actually\s+|really\s+|even\s+)?work\b`,
    String.raw`\bhas\s+anyone\s+(tried|used|tested)\b`,
    String.raw`\bshould\s+i\s+(use|try|get)\b`,
    String.raw`\bworth\s+(it|trying|using)\b`,
  ].join('|'),
  'i'
)
/** Mirrors COMPARISON in lib/commentGen.ts. */
const COMPARISON = new RegExp(
  [
    String.raw`\bwhich\s+(one|is)\s+(is\s+)?better\b`,
    String.raw`\bis\s+it\s+better\s+than\b`,
    String.raw`\b(any|other)\s+alternatives?\b`,
  ].join('|'),
  'i'
)
const CLICHES =
  /\b(beats?|beating|unbeatable|outperform\w*|outclass\w*|outrun\w*|wins?|winning|winner|rivals?|competitors?|competition|the\s+other\s+one|no\s+other\s+tool|number\s*one|hands\s+down|game\s*changer|superior)\b/i
const SLOGANS =
  /(#\s*1\b|\bno\.?\s*1\b|\bsecret\s+(\w+\s+)?weapon\b|\bholy\s+grail\b|\bthe\s+goat\b|\bgoated\b|\bundefeated\b|\bking\s+of\b|\bqueen\s+of\b|\bcrowned?\b|\breigns?\b|\bunmatched\b|\bunrivall?ed\b|\bflawless\b|\bmy\s+league\s+forever\b|\bchanged\s+my\s+life\b|\b10\s*\/\s*10\b|\bs-?tier\b|\bcheat\s+code\b|\bmagic\s+wand\b)/i
const JARGON = new RegExp(
  [
    String.raw`\bhumaniz(e|es|ed|er|ers|ing|ation)\b`,
    String.raw`\bai[\s-]?(content|text|writing|generated)\b`,
    String.raw`\bbypass(es|ed|ing)?\b`,
    String.raw`\bundetectable\b`,
    String.raw`\balgorithm(s|ic)?\b`,
    String.raw`\bparaphras(e|es|ed|ing|er)\b`,
    String.raw`\b(nlp|api)\b`,
    String.raw`\b(software|platform|solution|technology|engine)\b`,
    String.raw`\b(output|input)s?\b`,
    String.raw`\bgenerat(e|es|ed|ing|ion)\b`,
    String.raw`\b(accuracy|efficiency|seamless(ly)?|effortless(ly)?|optimi[sz]e[ds]?)\b`,
  ].join('|'),
  'i'
)
const DANGLING = new RegExp(
  '(^|\\s)(' +
    'a|an|and|as|at|but|by|for|from|in|into|is|its|just|like|my|of|on|or|our|really|so|than|the|their|then|to|very|was|were|when|while|with|without|your|about|after|before|every|even|have|has|had|do|does|did|will|would|can|could|get|gets|got|be|been|am|are' +
    ')[.,!?\\s]*$',
  'i'
)
const isQuestion = (s) => /\?\s*$/.test(s.trim())

/** Everything sanitize() applies to one line under a given voice. */
const survives = (s, voice) => {
  if (voice === 'question' || voice === 'curious') {
    if (!isQuestion(s)) return 'not a question'
    if (SELF_DOUBT.test(s)) return 'self-doubt'
    if (voice === 'curious' && COMPARISON.test(s)) return 'comparison (curious)'
  }
  if (CLICHES.test(s)) return 'cliche'
  if (SLOGANS.test(s)) return 'slogan'
  if (JARGON.test(s)) return 'jargon'
  if (DANGLING.test(s)) return 'dangling'
  return true
}

console.log('the four you asked for, under the question voice:')
for (const s of [
  'have you compared it with purify text?',
  'when will you show us trying purify text?',
  'how does this compare to purify text?',
  'does it give better result than purify text?',
]) {
  check(`  "${s}"`, survives(s, 'question'), true)
}

console.log('\nnearby shapes the model will also produce:')
for (const s of [
  'any chance of a video on purify text?',
  'would you run the same test on purify text?',
  'have you tried purify text on the same essay?',
  'could you show purify text next time?',
  'why not put purify text through the same check?',
]) {
  check(`  "${s}"`, survives(s, 'question'), true)
}

console.log('\nstill rejected — our own product put in doubt:')
for (const s of [
  'is purify text any good?',
  'does it actually work?',
  'has anyone tried purify text?',
  'should i use purify text?',
  'is purify text worth it?',
]) {
  check(`  "${s}"`, survives(s, 'question') !== true, true)
}

console.log('\nthe curious voice is unchanged — comparisons still rejected there:')
check('  "how does this compare to purify text?"',
  survives('how does this compare to purify text?', 'curious'), true)
check('  "which is better, this or purify text?"',
  survives('which is better, this or purify text?', 'curious') !== true, true)
console.log('   (a bare "compare to" is not one of the three banned forms, so it survives;')
console.log('    the curious voice is held to its shape by the prompt and the "you" rule)')

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
