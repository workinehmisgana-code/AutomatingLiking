/**
 * Does the model get told what the product actually IS?
 *
 * The prompts used to define every product as an AI humanizer — not as a
 * background note but in the instructions: "rewrites AI-written text so it reads
 * as human and gets past AI detectors", "the video promotes or reviews a RIVAL
 * humanizer". Pointed at a website builder that produces humanizer copy with the
 * wrong name in it, and the only way to notice is to read a generated comment.
 *
 * So the prompts are read here instead. Nothing is sent to a model: these
 * builders are pure, which is also what lets the admin page render the real
 * prompt in a browser.
 *
 *   node scripts/run-ts-check.mjs scripts/check-genre-prompts.ts
 */
import { buildAudiencePrompt } from '../lib/prompts'
import { copyForProduct, GENRE_COPY, SHARED_JARGON } from '../lib/prompts'
import {
  audiencesForProduct,
  fallbackCategory,
  GENRES,
  genreOfProduct,
  LINK_CATEGORIES,
  PRODUCTS,
  type LinkCategory,
} from '../lib/config'

let fails = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(
    `   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}` +
      (ok ? '' : ` (want ${JSON.stringify(want)})`)
  )
}

const BAND = { min: 6, max: 16 }
const STYLE = { voice: 'question', emoji: true, splitBrand: true } as never
const promptFor = (product: string, category: LinkCategory) =>
  buildAudiencePrompt(product as never, category, BAND, STYLE).toLowerCase()

// ── every product has copy, and it is its genre's ───────────────────────────
console.log('every product is described as the thing it is:')
for (const p of PRODUCTS) {
  const copy = copyForProduct(p)
  check(`  ${p} has copy for ${genreOfProduct(p)}`,
    copy === GENRE_COPY[genreOfProduct(p)], true)
}
check('  and every genre has an entry', GENRES.every((g) => !!GENRE_COPY[g]), true)

// ── the humanizer prompt is unchanged ───────────────────────────────────────
console.log('\nthe humanizer prompt still says what it always said:')
const hum = promptFor('purifytext', 'competitors')
check('  names the detectors', hum.includes('turnitin') && hum.includes('gptzero'), true)
check('  and the rival is a rival humanizer', hum.includes('rival humanizer'), true)
check('  with the product written as ordinary words', hum.includes('purify text'), true)

// ── and the new ones do not ─────────────────────────────────────────────────
console.log('\nthe website prompt is about websites, and nothing else:')
const web = promptFor('cocodly', 'generic')
check('  says what cocodly builds', web.includes('website') && web.includes('no coding'), true)
// THE WHOLE POINT. Any of these words in a cocodly prompt means the model is
// being briefed on the wrong product.
for (const word of ['humaniz', 'turnitin', 'gptzero', 'ai detector', 'detectors', 'essay']) {
  check(`  never mentions ${JSON.stringify(word)}`, web.includes(word), false)
}
check('  and the rival is a rival website builder',
  promptFor('cocodly', 'competitors').includes('rival website builder'), true)

console.log('\nthe slides prompt is about slides:')
const slides = promptFor('pptera', 'generic')
check('  says what pptera builds',
  slides.includes('slide') && slides.includes('speaker notes'), true)
for (const word of ['humaniz', 'turnitin', 'gptzero', 'ai detector']) {
  check(`  never mentions ${JSON.stringify(word)}`, slides.includes(word), false)
}
check('  and the rival is a rival deck tool',
  promptFor('pptera', 'competitors').includes('rival slide or deck tool'), true)

// ── the voice, which is where the giveaway phrasings live ───────────────────
console.log('\nthe voice tells each one what a real person would say:')
check('  humanizer: "it came back clean"',
  copyForProduct('purifytext').voice.includes('came back clean'), true)
check('  website: "live the same evening"',
  copyForProduct('cocodly').voice.includes('live the same evening'), true)
check('  slides: "done before class"',
  copyForProduct('pptera').voice.includes('done before class'), true)
// A humanizer phrasing in a slides voice is the same bug one layer down.
check('  and the slides voice never says turnitin',
  copyForProduct('pptera').voice.toLowerCase().includes('turnitin'), false)

// ── the reject filter ───────────────────────────────────────────────────────
console.log('\nthe reject filter catches each domain\'s own ad-speak:')
const re = (p: string) => new RegExp([...copyForProduct(p).jargon, ...SHARED_JARGON].join('|'), 'i')
check('  humanizer rejects "humanized"', re('purifytext').test('it humanized my essay'), true)
check('  website rejects "no-code"', re('cocodly').test('great no-code builder'), true)
check('  slides rejects "visually stunning"',
  re('pptera').test('visually stunning decks'), true)
// Shared in every genre: the company's nouns for itself.
for (const p of ['purifytext', 'cocodly', 'pptera']) {
  check(`  ${p} rejects "platform"`, re(p).test('a great platform'), true)
}
// And none of them rejects the ordinary sentence it is supposed to let through.
check('  none of them rejects a plain comment',
  ['purifytext', 'cocodly', 'pptera'].every((p) => !re(p).test('i used it and it was fine')),
  true)

// ── audiences ───────────────────────────────────────────────────────────────
console.log('\nthe new genres start on one audience:')
check('  humanizer uses all three', [...audiencesForProduct('purifytext')], [...LINK_CATEGORIES])
check('  cocodly uses generic only', [...audiencesForProduct('cocodly')], ['generic'])
check('  pptera too', [...audiencesForProduct('pptera')], ['generic'])
check('  and an uncategorised link falls back to it',
  [fallbackCategory('humanizer'), fallbackCategory('website'), fallbackCategory('slides')],
  ['competitors', 'generic', 'generic'])

console.log(`\n${fails === 0 ? 'all correct' : `${fails} FAILED`}`)
process.exit(fails === 0 ? 0 : 1)
