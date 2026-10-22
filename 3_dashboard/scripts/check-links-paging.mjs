// Can you reach the last page of the admin Links table?
//
// THE TABLE PAGES THROUGH A WINDOW. The server sends WINDOW_SIZE rows at a time
// and the table shows PAGE_SIZE of them; when the cursor leaves the rows it
// holds, the next window is fetched. Two different numbers, and the Next button
// was bounded by the wrong one:
//
//   1,478 links · showing 501–1000 · page 2 / 3 · Next DISABLED
//
// `ordered.length` is the window (1,000 rows), `matched` is the filtered set
// (1,478). Bounding Next by the window killed it halfway through the second
// page of three, and the last 478 links could not be reached at all — while the
// counter, which uses `matched`, went on advertising a third page.
//
//   node scripts/check-links-paging.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const ui = readFileSync(new URL('../components/AdminLinks.tsx', import.meta.url), 'utf8')

const PAGE_SIZE = Number(ui.match(/const PAGE_SIZE = (\d+)/)?.[1] ?? 0)
const WINDOW_SIZE = Number(ui.match(/const WINDOW_SIZE = (\d+)/)?.[1] ?? 0)
console.log(`page ${PAGE_SIZE} rows, window ${WINDOW_SIZE} rows:`)
check('  both are set', PAGE_SIZE > 0 && WINDOW_SIZE > 0, true)
// The window has to divide into whole pages or a page would straddle two
// fetches, which is what the cursor arithmetic assumes throughout.
check('  the window is whole pages', WINDOW_SIZE % PAGE_SIZE, 0)

// ── the rule, as the component now computes it ─────────────────────────────
const pageCount = (matched) => Math.max(1, Math.ceil(matched / PAGE_SIZE))
const lastOffset = (matched) => Math.max(0, (pageCount(matched) - 1) * PAGE_SIZE)
const nextDisabled = (matched, offset) => {
  const clamped = Math.min(Math.max(0, offset), Math.max(0, matched - 1))
  return clamped >= lastOffset(matched)
}
// What it used to be, for contrast: bounded by the rows in hand.
const oldDisabled = (matched, offset) => {
  const held = Math.min(WINDOW_SIZE, matched - Math.floor(offset / WINDOW_SIZE) * WINDOW_SIZE)
  const clamped = Math.min(Math.max(0, offset), Math.max(0, matched - 1))
  return clamped + PAGE_SIZE >= Math.floor(offset / WINDOW_SIZE) * WINDOW_SIZE + held
}

// The report from the page, exactly.
console.log(`\n1,478 links, ${PAGE_SIZE} to a page:`)
check('  three pages', pageCount(1478), 3)
check('  the last starts at 1000', lastOffset(1478), 1000)
check('  page 1 -> Next live', nextDisabled(1478, 0), false)
check('  page 2 -> Next live (this was the bug)', nextDisabled(1478, 500), false)
check('  page 3 -> Next dead', nextDisabled(1478, 1000), true)
check('  and the old rule killed it on page 2', oldDisabled(1478, 500), true)

console.log('\nevery page of a few other sizes is reachable:')
for (const matched of [0, 1, 499, 500, 501, 1000, 1001, 2500, 171762]) {
  const pages = pageCount(matched)
  // Walk from the first page to the last the way a person clicking Next does,
  // and check we arrive at the final page rather than stopping short.
  let offset = 0
  let clicks = 0
  while (!nextDisabled(matched, offset) && clicks < 10000) {
    offset = Math.min(lastOffset(matched), offset + PAGE_SIZE)
    clicks++
  }
  const reached = Math.floor(Math.min(offset, Math.max(0, matched - 1)) / PAGE_SIZE) + 1
  check(`  ${matched.toLocaleString()} link(s): ${pages} page(s), Next reaches page ${reached}`,
        reached, pages)
}

console.log('\nthe last page shows the remainder, not a short page somewhere else:')
const lastShown = (matched) => {
  const o = lastOffset(matched)
  return [o + 1, Math.min(matched, o + PAGE_SIZE)]
}
check('  1,478 -> 1001-1478', lastShown(1478), [1001, 1478])
check('  1,000 -> 501-1000', lastShown(1000), [501, 1000])
check('  1,001 -> 1001-1001', lastShown(1001), [1001, 1001])

// ── the wiring ─────────────────────────────────────────────────────────────
console.log('\nand the button uses it:')
check('  Next is bounded by the filtered set',
      /disabled=\{clampedOffset >= lastOffset\}/.test(ui), true)
check('  and steps to it', /setOffset\(\(o\) => Math\.min\(lastOffset, o \+ PAGE_SIZE\)\)/.test(ui), true)
check('  nothing bounds paging by the window any more',
      /ordered\.length\)\}/.test(ui), false)
// Paging past the held rows is meant to fetch the next window rather than stop.
check('  leaving the window fetches the next one',
      /loadWindow\(Math\.floor\(offset \/ WINDOW_SIZE\) \* WINDOW_SIZE\)/.test(ui), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
