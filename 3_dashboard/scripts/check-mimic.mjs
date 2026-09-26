// A comment written to match one already under the video.
//
// The liker finds a comment recommending a rival tool and asks for ours said
// the same way. Measured against the real model, through the real endpoint:
//
//   in   ngl walterwrites got me through finals, tried everything else first
//   out  prohumanly saved my english essay last week
//
//   in   bro just use grubbyai it passed my whole essay first try
//   out  used prohumanly for my term project last week
//
// TWO THINGS THE TESTING CHANGED, both of which a reviewer would otherwise
// find in production:
//
//   IT NAMED THE RIVAL. Given "quillbot never worked for me but stealthwriter
//   actually passes turnitin" it wrote "tried quillbot first but prohumanly
//   fixed it" — our own comment advertising somebody else's tool, under a video
//   we are trying to win. The prompt already forbade it; the prompt is not
//   enforcement.
//
//   IT MANGLED SENTENCES. "prohumanly saved my a midnight" — five words, the
//   right length, not English. The shared output rules tell the model to write
//   "exactly the number of words its line asks for", and the mimic request asks
//   for no such thing, so it was padding to hit a target nobody had set.
//
//   node scripts/check-mimic.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const mimic = read('lib/commentMimic.ts')
const prompt = read('lib/commentPrompt.ts')
const route = read('app/api/links/mimic/route.ts')
const gen = read('lib/commentGen.ts')
const cat = read('lib/linkCategory.ts')

console.log('it goes through the same filters as every stored comment')
// A second implementation of the mention rule, the word band, the jargon filter
// and the cliche filter is how two comment paths end up with two different
// ideas of what is postable.
check('  the sanitiser is shared, not copied', /export function sanitize/.test(gen), true)
check('  and this uses it', /sanitize\(product, await ask\(/.test(mimic), true)
check('  with the cliche filter on', /banCliches: true/.test(mimic), true)
check('  and the product’s own band and style', /await settingsFor\(product\)/.test(mimic), true)

console.log('\nand two rules of its own')
// The same sentence under fifty videos is a pattern somebody can search for.
check('  the sample cannot come back', /flat\(c\) !== source/.test(mimic), true)
check('  said out loud', /THE SAMPLE MUST NOT COME BACK/.test(mimic), true)
// Enforced, not requested.
check('  and it may not name a rival', /!mentionsRival\(c\)/.test(mimic), true)
check('  with the measured example written down', /tried quillbot first but/.test(mimic), true)
check('  the prompt asks too', /Never name the other tool/.test(prompt), true)

console.log('\nthe length rule matches the request that is actually sent')
check('  the per-line rule can be turned off', /perLineLength = true/.test(prompt), true)
check('  and the mimic turns it off',
      /outputRules\(band, style, mention, forms, false\)/.test(prompt), true)
// And the forms go with it, so the mimic names the product the same way as
// everything else — as words in a sentence.
check('  with the same words rule', /const forms = productForms\(product\)/.test(prompt), true)
check('  asking for a range instead', /reads as a real sentence/.test(prompt), true)
check('  with the mangled example kept', /five words and not English/.test(prompt), true)

console.log('\nit retries once before giving up')
// A comparative sample makes the model write comparisons, and every one of them
// names somebody else's tool: the first attempt produced nothing usable three
// times out of three.
check('  five candidates, not one', /Write 5 comments/.test(mimic), true)
check('  a second attempt says why', /your last attempt named another tool/.test(mimic), true)
check('  and only when the first found nothing', /if \(!usable\) \{/.test(mimic), true)

console.log('\nfailure is an empty comment, never an error')
// A model that returns nothing, times out, or fails to produce JSON all mean
// one thing to the liker: post a stored comment instead.
check('  generation failures are caught', /catch \(e\) \{\s*\n\s*note = String/.test(route), true)
check('  and reported as no comment', /source: comment \? 'mimic' : 'none'/.test(route), true)
check('  with a note saying why', /note,/.test(route), true)
check('  the liker knows what that means', /falls back to the bank/.test(route), true)

console.log('\none list of rival names, in one place')
check('  exported rather than copied', /export const COMPETITOR_BRANDS/.test(cat), true)
check('  and served to the liker', /brands: COMPETITOR_BRANDS/.test(route), true)
check('  with the reason written down', /a list that will disagree/.test(cat), true)

console.log('\nand the endpoint is closed to everybody else')
check('  same token as the other liker endpoints', /LINKS_EXPORT_TOKEN/.test(route), true)
check('  on the list', /if \(!authed\(req\)\) return NextResponse\.json\(\{ error: 'Unauthorized' \}/.test(route), true)
// The product is the same fair pick the app and the stored-comment endpoint
// make, so turning the setting on does not quietly change which product gets
// promoted.
check('  the product is the usual fair pick', /pickFairProductForUrl\(url, active\)/.test(route), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
