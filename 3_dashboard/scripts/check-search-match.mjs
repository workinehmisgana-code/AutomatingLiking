// HOW the Links-page search matches, as opposed to where it looks.
//
// Two switches sit in the "in:" menu beside the field checkboxes:
//
//   Whole word only   "human" matches "human text" and "a human." but not
//                     "humanizer" or "superhuman".
//   Match case        "Human" stops matching "human".
//
// Both are off unless ticked, so an old bookmark or a shared link keeps the
// substring search it was written against.
//
// This file does not re-implement the rule. It lifts escapeRe and makeMatcher
// out of lib/adminLinks.ts and runs those, so a change to the library that
// breaks the behaviour fails here instead of passing against a stale copy.
//
//   node scripts/check-search-match.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const lib = read('lib/adminLinks.ts')
const ui = read('components/AdminLinks.tsx')

// ── the real matcher, borrowed ──────────────────────────────────────────────
const from = lib.indexOf('function escapeRe(')
const tail = 'return (hay) => re.test(hay)\n}'
const to = lib.indexOf(tail, from)
if (from < 0 || to < 0) {
  console.log('   FAIL could not find escapeRe/makeMatcher in lib/adminLinks.ts')
  process.exit(1)
}
const ts = lib.slice(from, to + tail.length)
const js = ts
  .replace('): (hay: string) => boolean {', ') {')
  .replace(/(\w+): (?:string|boolean)/g, '$1')
  .replace(/\): string \{/g, ') {')
const makeMatcher = new Function(`${js}\nreturn makeMatcher`)()

// ── the example from the request ────────────────────────────────────────────
const hay = {
  'humanizer tool': { plain: true, word: false },
  'a human writes': { plain: true, word: true },
  'the human.': { plain: true, word: true },
  'ai-human-text': { plain: true, word: true },
  superhuman: { plain: true, word: false },
  '/tag/human': { plain: true, word: true },
}
console.log('searching "human" without the switch finds everything it ever did:')
for (const [text, want] of Object.entries(hay))
  check(`  ${text}`, makeMatcher('human', false, false)(text), want.plain)

console.log('\nwith "whole word only" the longer words drop out:')
for (const [text, want] of Object.entries(hay))
  check(`  ${text}`, makeMatcher('human', true, false)(text), want.word)

console.log('\n"match case" is independent of it:')
check('  off: HUMAN rights matches "human"', makeMatcher('human', false, false)('HUMAN rights'), true)
check('  on: it does not', makeMatcher('human', false, true)('HUMAN rights'), false)
check('  on: "HUMAN" does', makeMatcher('HUMAN', false, true)('HUMAN rights'), true)
check('  both on: whole word still applies',
      makeMatcher('HUMAN', true, true)('HUMANIZER tool'), false)
check('  both on: and the exact word is found',
      makeMatcher('HUMAN', true, true)('HUMAN rights'), true)

// A word boundary is defined between a word character and a non-word one, so
// anchoring blindly would make "@me" and "c++" unfindable the moment somebody
// ticked the box — the needle's own first and last characters decide instead.
console.log('\nneedles that do not begin or end in a letter still work whole-word:')
check('  @handle', makeMatcher('@me', true, false)('hi @me there'), true)
check('  c++', makeMatcher('c++', true, false)('i use c++ daily'), true)
check('  a domain', makeMatcher('.com', true, false)('see example.com now'), true)
check('  a phrase matches as a phrase', makeMatcher('purify text', true, false)('try purify text today'), true)
check('  and not as a prefix of a longer word',
      makeMatcher('purify text', true, false)('try purify textual today'), false)

// Regex metacharacters in the box are text, not syntax. Without escaping, "c++"
// alone would throw on `new RegExp` and take the whole request down with it.
console.log('\nwhat somebody types is text, never a pattern:')
check('  a dot is a dot', makeMatcher('a.b', true, false)('axb'), false)
check('  and matches itself', makeMatcher('a.b', true, false)('a.b here'), true)
let threw = ''
try {
  makeMatcher('(unclosed[', true, false)('nothing')
} catch (e) {
  threw = String(e)
}
check('  an unbalanced bracket does not throw', threw, '')

// ── the wiring, end to end ─────────────────────────────────────────────────
console.log('\nthe switches reach the filter:')
check('  the query type carries them', /wholeWord\?: boolean \| null/.test(lib) && /caseSensitive\?: boolean \| null/.test(lib), true)
check('  the server parses them', /wholeWord: sp\.get\('wholeWord'\) === '1'/.test(lib) && /caseSensitive: sp\.get\('caseSensitive'\) === '1'/.test(lib), true)
check('  the page sends them', /if \(wholeWord\) p\.set\('wholeWord', '1'\)/.test(ui) && /if \(caseSensitive\) p\.set\('caseSensitive', '1'\)/.test(ui), true)
check('  and a change refetches', /q, searchIn, wholeWord, caseSensitive, sort\]/.test(ui), true)
check('  the menu offers both', /Whole word only/.test(ui) && /Match case/.test(ui), true)
check('  Reset clears them too', /setWholeWord\(false\)[\s\S]{0,60}setCaseSensitive\(false\)/.test(ui), true)
check('  the button says when one is on', /\{wholeWord && <span/.test(ui), true)

// The matcher is built once per search, not once per row: the pool is tens of
// thousands of links and the needle does not change between them.
console.log('\nbuilt once per search, not per row:')
check('  compiled outside the row loop', /const matches = rawNeedle\s*\n?\s*\? makeMatcher\(/.test(lib), true)
check('  the row test only calls it', /if \(matches && !fields\.some\(\(f\) => matches\(searchText\(l, f\)\)\)\) return false/.test(lib), true)

// searchText used to lowercase four fields and leave channel raw. Harmless while
// every search folded case, wrong the moment one does not.
console.log('\nthe field reader no longer decides case for everybody:')
check('  url is raw', /case 'url':\s*\n\s*return l\.url\s*\n/.test(lib), true)
check('  keyword is raw', /return l\.search_query\s*\n/.test(lib), true)
check('  title is raw', /return l\.title\s*\n/.test(lib), true)
check('  bio is raw', /return l\.bio\s*\n/.test(lib), true)
check('  and nothing lowercases inside it', /searchText[\s\S]{0,420}toLowerCase/.test(lib), false)

// ── against the real pool ──────────────────────────────────────────────────
// Numbers, not assertions: this says what the switch is worth on the links that
// actually exist. Skipped without a blob token.
if (process.env.BLOB_READ_WRITE_TOKEN || safeEnv()) {
  try {
    const { list } = await import('@vercel/blob')
    const { blobs } = await list({ prefix: 'videos.json' })
    const pool = await (
      await fetch(blobs[0].url, {
        headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
        cache: 'no-store',
      })
    ).json()
    const texts = pool
      .filter((v) => v?.url)
      .map((v) => [String(v.url), String(v.search_query ?? ''), String(v.title ?? '')])
    const count = (needle, word) => {
      const m = makeMatcher(needle, word, false)
      return texts.filter((t) => t.some((x) => m(x))).length
    }
    console.log(`\nover ${texts.length.toLocaleString()} links (url, keyword, title):`)
    for (const needle of ['human', 'ai', 'text', 'detector']) {
      const a = count(needle, false)
      const b = count(needle, true)
      console.log(`   "${needle}": ${a.toLocaleString()} anywhere, ${b.toLocaleString()} as a whole word (${(a - b).toLocaleString()} were part of a longer word)`)
    }
  } catch (e) {
    console.log(`\n   (pool check skipped: ${e.message})`)
  }
}

function safeEnv() {
  try {
    const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    for (const l of env.split('\n')) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    return Boolean(process.env.BLOB_READ_WRITE_TOKEN)
  } catch {
    return false
  }
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
