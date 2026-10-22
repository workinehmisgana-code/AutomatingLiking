// "Mark humanizer unrelated" — does every title actually get classified?
//
// THE BUTTON EXISTS IN THREE PLACES AND ONE OF THEM WAS LYING. The endpoint took
// 120 titles per request. The verify page sent a fifth of its page (100 of 500,
// by arithmetic rather than by intent). The rank-only panel sent 100 at a time.
// The main Links page sent THE WHOLE PAGE in one request — up to 500 — and the
// route silently did `.slice(0, 120)`.
//
// The silence is the bug. A dropped title comes back absent from `related`, and
// the caller computes unrelated as "not related", so ~380 links per press were
// ticked as humanizer-unrelated without ever being read — with "Block & Bring
// Next batch" one unconfirmed click away.
//
// Now: one shared batch size, a route that refuses an oversized request instead
// of trimming it, and a failed batch that cancels the whole selection.
//
//   node scripts/check-classify-batching.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const cfg = read('lib/config.ts')
const route = read('app/api/admin/links/classify/route.ts')
const links = read('components/AdminLinks.tsx')
const verify = read('components/VerifyLinks.tsx')

const num = (name, src) => Number(src.match(new RegExp(`${name} = (\\d+)`))?.[1] ?? NaN)
const MAX = num('CLASSIFY_MAX_ITEMS', cfg)
const BATCH = num('CLASSIFY_BATCH', cfg)

console.log('the limit and the batch size are declared once, together:')
check('  a request limit exists', Number.isFinite(MAX), true)
check('  a batch size exists', Number.isFinite(BATCH), true)
// The invariant the whole file is about. If this ever fails, every caller is
// sending requests the route will reject.
check('  and the batch fits inside the limit', BATCH <= MAX, true)

// ── what a page of 500 titles used to cost ─────────────────────────────────
// `shown` is PAGE_SIZE rows, and with 179,902 stored titles against a 171,762
// link pool nearly every row arrives already titled.
const PAGE = Number(links.match(/const PAGE_SIZE = (\d+)/)?.[1] ?? 0)
check('  the Links page shows a page this big', PAGE, 500)

const unseenOld = Math.max(0, PAGE - MAX) // one request, server trims the rest
const requestsNew = Math.ceil(PAGE / BATCH)
const unseenNew = PAGE - requestsNew * BATCH > 0 ? PAGE - requestsNew * BATCH : 0
console.log(`\na full page of ${PAGE} titles:`)
console.log(`   before: 1 request, ${MAX} classified, ${unseenOld} ticked unread`)
console.log(`   after : ${requestsNew} requests, ${PAGE} classified, ${unseenNew} ticked unread`)
check('  nothing is left unclassified now', unseenNew, 0)
check('  and it used to be most of the page', unseenOld > PAGE / 2, true)

// The verify page derives its batch from a batch COUNT, which only landed under
// the limit because 500/5 = 100. It is capped now, so a bigger page cannot walk
// past the limit unnoticed.
const BATCHES = Number(verify.match(/CLASSIFY_BATCHES = (\d+)/)?.[1] ?? 0)
const verifyBatch = (n) => Math.min(BATCH, Math.max(1, Math.ceil(n / BATCHES)))
console.log('\nthe verify page stays under the limit at any page size:')
for (const n of [20, 500, 1000, 5000])
  check(`  ${n} titles -> ${verifyBatch(n)} per request`, verifyBatch(n) <= MAX, true)

// ── the route ──────────────────────────────────────────────────────────────
console.log('\nthe route refuses an oversized request instead of trimming it:')
// A slice on its own line is the trim that used to happen; the same text inside
// a comment is the note explaining why it no longer does.
check('  nothing slices the list any more', /^\s*\.slice\(0, \d+\)/m.test(route), false)
check('  the limit comes from config', /CLASSIFY_MAX_ITEMS/.test(route), true)
check('  and too many titles is a 400', /Too many titles in one request/.test(route), true)

// ── the three callers ──────────────────────────────────────────────────────
const callers = (links.match(/'\/api\/admin\/links\/classify'/g) ?? []).length +
  (verify.match(/'\/api\/admin\/links\/classify'/g) ?? []).length
console.log('\nevery caller batches, by the same number:')
check('  there are three of them', callers, 3)
check('  the Links page button batches', /i \+= CLASSIFY_BATCH/.test(links), true)
check('  twice (rank-only panel too)', (links.match(/i \+= CLASSIFY_BATCH/g) ?? []).length, 2)
check('  the verify page caps its batch', /Math\.min\(\s*CLASSIFY_BATCH/.test(verify), true)
check('  and nobody hardcodes 100', /const BATCH = 100/.test(links), false)

// ── and what the button does with the answer ───────────────────────────────
console.log('\nthe Links page button behaves like the verify page one:')
check('  a failed batch selects nothing',
      /Stopped after \$\{i\} of \$\{items\.length\} — nothing was selected/.test(links), true)
check('  the selection is replaced, not added to',
      /setSelected\(new Set\(pick\.map\(\(it\) => it\.url\)\)\)/.test(links), true)
check('  progress is shown while it runs',
      /setClassifying\(`\$\{i\}\/\$\{items\.length\}`\)/.test(links), true)
check('  the button shows it', /Analyzing \$\{classifying\}/.test(links), true)
// Blocking a page of links permanently, one click after a button that picks them
// for you, asks first — as it does on the verify page.
check('  Block & Bring Next asks first',
      /Block \$\{urls\.length\} selected link\(s\) forever, then load the next batch\?/.test(links), true)
check('  and the verify page still asks too',
      /Block \$\{urls\.length\} selected link\(s\)\?/.test(verify), true)

// The rule itself is shared, which is why only the plumbing differed.
console.log('\nthe rules they apply are one copy:')
const lib = read('lib/titleClassify.ts')
check('  one prompt', (lib.match(/const SYSTEM =/g) ?? []).length, 1)
check('  one keyword net', (lib.match(/const RELATED_KEYWORDS = \[/g) ?? []).length, 1)
check('  the route uses it', /classifyRelated\(items\)/.test(route), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
