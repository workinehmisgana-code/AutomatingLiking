// Does every admin table still scroll sideways once it is filtered?
//
// A bare `overflow-x-auto` shows a scrollbar only while its CONTENT is wider
// than the box — and the content is the rows. Search the table down to three
// rows and the widest row goes with them, the table shrinks to fit, and the
// scroll silently disappears along with the right-hand columns.
//
// The fix is always the same shape: an inner element whose width does not
// depend on the rows — `min-w-max` over a header of fixed shrink-0 columns, an
// explicit `min-w-[Npx]`, or the ScrollX wrapper. This checks that every
// scroller in the admin UI has one.
//
//   node scripts/check-table-scroll.mjs
import { readFileSync, readdirSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

const dir = new URL('../components/', import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'))

// ScrollX itself is the fix, so it is exempt from its own rule.
const EXEMPT = new Set(['ScrollX.tsx'])

console.log('every horizontal scroller is pinned to a width the rows cannot change:')
let scrollers = 0
let pinned = 0
for (const f of files) {
  if (EXEMPT.has(f)) continue
  const src = readFileSync(new URL(f, dir), 'utf8')
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('overflow-x-auto')) continue
    scrollers++
    // The pin has to be within a few lines: the scroller's own immediate child.
    const window = lines.slice(i, i + 4).join(' ')
    const ok = /min-w-max|\bw-max\b|min-w-\[\d+px\]|minWidth/.test(window)
    if (ok) pinned++
    else {
      fails++
      console.log(`   FAIL ${f}:${i + 1} — overflow-x-auto with nothing setting its width`)
      console.log(`        ${lines[i].trim().slice(0, 90)}`)
    }
  }
}
check(`  ${scrollers} scroller(s), all pinned`, pinned, scrollers)

console.log('\nthe scrollbar sits above the table:')
const sxSrc = readFileSync(new URL('ScrollX.tsx', dir), 'utf8')
// Counted by their refs, not by the class name — the doc comment names the
// class too, and the first version of this check counted that.
check('  there are two scrollers, one above the other',
  /ref=\{top\}/.test(sxSrc) && /ref=\{body\}/.test(sxSrc), true)
check('  the two are kept in step', /scrollLeft = a\.scrollLeft/.test(sxSrc), true)
// Without this guard each scroller's handler writes to the other, which fires
// its handler, which writes back — the bar and the table fight each other.
check('  with a guard against them driving each other', /driving\.current/.test(sxSrc), true)
check('  the top strip is hidden from screen readers', /aria-hidden/.test(sxSrc), true)

console.log('\nScrollX does what it claims:')
const sx = readFileSync(new URL('ScrollX.tsx', dir), 'utf8')
check('  it applies overflow-x-auto', /overflow-x-auto/.test(sx), true)
check('  the inner element carries a minWidth', /minWidth/.test(sx), true)
// Tailwind only emits arbitrary values it can see in the source, so a computed
// min-w-[${n}px] class would produce no CSS at all. It must be inline style.
check('  the width is an inline style, not a computed class', /min-w-\[\$\{/.test(sx), false)

console.log('\nwho uses it:')
for (const f of files) {
  const src = readFileSync(new URL(f, dir), 'utf8')
  const n = (src.match(/<ScrollX/g) || []).length
  const m = (src.match(/min-w-max/g) || []).length
  const k = (src.match(/min-w-\[\d+px\]/g) || []).length
  if (n + m + k > 0) {
    console.log(`   ${f.padEnd(26)} ${n} ScrollX · ${m} min-w-max · ${k} fixed min-width`)
  }
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
