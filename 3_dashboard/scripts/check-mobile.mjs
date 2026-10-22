// Can the admin work be done on a phone?
//
// MEASURED, not guessed. Every admin page was loaded in a 390x844 touch browser
// with its real data, and the two things that decide whether a page is usable
// were counted: elements wider than the screen that nothing can scroll, and tap
// targets too small to hit.
//
// The finding was not what it looked like. Every wide table was already inside
// an overflow-x-auto container, so nothing was unreachable — the problem was
// SIZE:
//
//     /admin              325 of 494 tap targets under 32px tall
//     /admin/links        19 under 24px, including 13x13px checkboxes
//     /admin/replies      a 47x20px back link, 56x26px number fields
//
// A 13-pixel checkbox is smaller than the tip of a finger, in a table where
// ticking the wrong row blocks the wrong link. And every input was text-xs,
// which on iOS means the page ZOOMS IN when a field takes focus and does not
// zoom back out — one tap on a filter box and the admin is looking at a corner
// of a page that no longer fits.
//
// Fixed in one place, under `pointer: coarse`, because it is one rule about
// fingers rather than fifty decisions about layout — and the desktop admin,
// where all of this was fine, is untouched. After it:
//
//     /admin              3 under 32px (inline links inside sentences)
//     /admin/links        checkboxes 24x24, no page zoom on focus
//     /admin/tasks        0 under 32px
//
//   node scripts/check-mobile.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const css = read('app/globals.css')
const layout = read('app/layout.tsx')

console.log('the page is allowed to be a phone-sized page at all')
check('  the viewport is the device width', /width: 'device-width'/.test(layout), true)

console.log('\nand the touch rules exist, for touch only')
// Scoped to coarse pointers: the desktop admin is dense on purpose and a mouse
// hits an 11px button perfectly well.
check('  scoped to a finger', /@media \(pointer: coarse\)/.test(css), true)
const touch = css.split('@media (pointer: coarse)')[1] ?? ''
check('  buttons get a finger-sized hit area', /button,[\s\S]{0,80}min-height: 32px/.test(touch), true)
// 13x13 was the measured size of the checkboxes in the links table.
check('  checkboxes are grown', /input\[type='checkbox'\][\s\S]{0,120}width: 1\.5rem/.test(touch), true)
check('  and so are radios', /input\[type='radio'\]/.test(touch), true)
// THE ZOOM. Any field under 16px makes iOS zoom the whole page on focus.
check('  fields are 16px, so iOS does not zoom', /font-size: 16px/.test(touch), true)
check('  which the comment explains', /ZOOMS THE WHOLE PAGE/.test(css), true)
check('  fields are tall enough to hit', /min-height: 36px/.test(touch), true)
// A table wider than the screen is fine as long as it moves.
check('  wide tables keep momentum scrolling', /-webkit-overflow-scrolling: touch/.test(touch), true)

console.log('\nan inline link in a sentence is left alone')
// A link inside a paragraph is not a button, and making it 32px tall breaks the
// line it sits in. Only links already laid out as controls are grown.
check('  only links that look like controls', /a\[href\]\[class\*='border'\]/.test(touch), true)
check('  and the reason is written down', /not a button/.test(css), true)
// The ones that ARE controls say so where they are written.
check('  the task page back link', /min-h-\[32px\]/.test(read('components/AdminAccountTasks.tsx')), true)
check('  and the replies one', /min-h-\[32px\]/.test(read('components/AdminReplies.tsx')), true)

console.log('\nthe email task shows who to ask about a submission')
const tasks = read('components/AdminAccountTasks.tsx')
check('  the row carries a phone', /phone: string \| null/.test(tasks), true)
check('  and a telegram', /telegram: string \| null/.test(tasks), true)
// Tap-to-call and tap-to-chat: this page is now used on a phone, and an admin
// reviewing a mailbox is mostly asking the person about it.
check('  the phone dials', /href={`tel:\$\{r\.phone\}`}/.test(tasks), true)
check('  the telegram opens the chat', /https:\/\/t\.me\/\$\{r\.telegram\}/.test(tasks), true)
// Somebody who registered before this was asked for has neither, and a blank
// row would read as a bug.
check('  and says when there is neither', /registered before we asked/.test(tasks), true)

const db = read('lib/db.ts')
console.log('\nwhich the query actually fetches')
check('  joined from the profile', /LEFT JOIN user_profile p ON p\.user_id = a\.user_id/.test(db), true)
check('  and selected', /p\.phone, p\.telegram/.test(db), true)
// An admin holding a phone number is trying to find out whose submission it is.
check('  searchable by them too', /lower\(COALESCE\(p\.phone, ''\)\) LIKE/.test(db), true)

// ── the admin screens, as rules rather than as a snapshot ───────────────────
//
// Everything below is computed over every admin component, so a modal or a table
// added later is held to the same rule without anybody editing this file.
const { readdirSync } = await import('node:fs')
const compDir = new URL('../components/', import.meta.url)
const ADMIN = /^(Admin|Scan|Comment(Frequency)?|Verify(Links)?|Pipeline|Platform|Active|Apk|Guide|Promo|Llm|UserMessages|EditAccount)/
const admin = readdirSync(compDir)
  .filter((f) => f.endsWith('.tsx') && ADMIN.test(f))
  .map((f) => ({ f, src: readFileSync(new URL(f, compDir), 'utf8') }))

console.log('\nevery admin modal is the whole screen on a phone')
// A 360px screen spent 32px of width and 64px of height on margins around a card
// that then had 292px to render a table in. Below sm: the modal IS the screen.
const overlays = []
for (const { f, src } of admin) {
  for (const m of src.matchAll(/className=(?:"|\{`)(fixed inset-0 [^"`]*)/g)) {
    const cls = m[1]
    // z-40 overlays are click-catchers behind a menu, not panels.
    if (/z-40(?!\d)/.test(cls) && !/flex/.test(cls)) continue
    if (!/flex/.test(cls)) continue
    overlays.push({ f, cls })
  }
}
check('  there are modals to check', overlays.length > 0, true)
const padded = overlays.filter(
  (o) => /\bp-4\b|\bpx-4\b|\bpy-8\b/.test(o.cls) && !/sm:p-4|sm:px-4|sm:py-8/.test(o.cls)
)
// px-4 alone on a short centred dialog is fine — the card is narrow anyway. What
// must not happen is a big scrolling panel keeping its padding on a phone.
const bigPadded = padded.filter((o) => /overflow-y-auto|items-start/.test(o.cls))
check(
  '  no big panel keeps its padding below sm',
  bigPadded.map((o) => `${o.f}: ${o.cls.slice(0, 60)}`),
  []
)

console.log('\nand no panel floats in the middle of a phone screen')
const panels = []
for (const { f, src } of admin) {
  // Any panel wide enough to be a page: the named sizes and the bracket ones
  // ([80rem] and friends), which the first version of this rule missed.
  for (const m of src.matchAll(
    /className="([^"]*\bmax-w-(?:2xl|3xl|4xl|5xl|6xl|7xl|\[[\w.]+\])[^"]*)"/g
  )) {
    panels.push({ f, cls: m[1] })
  }
}
const floating = panels.filter(
  (p2) =>
    /\bmy-8\b|\bmy-auto\b|\bmt-6\b/.test(p2.cls) &&
    !/sm:my-8|sm:my-auto|sm:mt-6/.test(p2.cls)
)
check('  wide panels lose their vertical margin below sm', floating.map((p2) => p2.f), [])
const roundOnPhone = panels.filter(
  (p2) =>
    /\brounded-(?:xl|2xl)\b/.test(p2.cls) &&
    !/rounded-none sm:rounded-(?:xl|2xl)/.test(p2.cls)
)
check('  and their corners', roundOnPhone.map((p2) => `${p2.f}: ${p2.cls.slice(0, 50)}`), [])

console.log('\na short dialog can still be scrolled when it does not fit')
const shortDialogs = []
for (const { f, src } of admin) {
  for (const m of src.matchAll(/className="([^"]*\bmax-w-(?:sm|md|lg)\b[^"]*\bp-5\b[^"]*)"/g)) {
    shortDialogs.push({ f, cls: m[1] })
  }
}
const unscrollable = shortDialogs.filter((d) => !/max-h-/.test(d.cls))
check('  every one has a ceiling', unscrollable.map((d) => d.f), [])

console.log('\nno table is left to squash')
// A table wider than a phone is fine — it scrolls. A table wider than a phone
// with nothing to scroll it makes the whole PAGE scroll sideways, which moves the
// header and the buttons off screen too.
const wide = []
for (const { f, src } of admin) {
  for (const m of src.matchAll(/min-w-\[(\d+)px\]/g)) {
    if (Number(m[1]) <= 360) continue
    const before = src.slice(Math.max(0, m.index - 400), m.index)
    const scrolled = /overflow-x-auto|overflow-auto|<ScrollX/.test(before)
    if (!scrolled) wide.push(`${f}: min-w-[${m[1]}px]`)
  }
}
check('  each wide block sits in a scroller', wide, [])

console.log('\nno grid keeps its columns on a phone')
const grids = []
for (const { f, src } of admin) {
  for (const m of src.matchAll(/className="([^"]*)"/g)) {
    const cls = m[1]
    // THREE OR MORE with nothing to widen it later. Two columns of short stats
    // is right on a phone and stays two; "grid-cols-2 sm:grid-cols-5" is the
    // shape to aim for, not a fault. Three at 360px is 100px a column.
    const base = cls.match(/(?:^|\s)grid-cols-([3-9]|1[0-2])(?:\s|$)/)
    const responsive = /(?:sm|md|lg|xl):grid-cols-/.test(cls)
    if (base && !responsive) grids.push(`${f}: ${cls.slice(0, 50)}`)
  }
}
check('  every fixed column count is behind a breakpoint', grids, [])

console.log('\nthe long rows wrap instead of shrinking to nothing')
const freq = readFileSync(new URL('CommentFrequency.tsx', compDir), 'utf8')
const dash = readFileSync(new URL('AdminDashboard.tsx', compDir), 'utf8')
check('  the frequency list', /flex flex-wrap sm:flex-nowrap items-baseline/.test(freq), true)
check('  the comment gets its own line', /order-last sm:order-none basis-full/.test(freq), true)
check('  and position\u00b7date step aside', /hidden sm:inline-block/.test(freq), true)
check('  the verify report links', /flex flex-wrap sm:flex-nowrap items-center/.test(dash), true)
check('  the comment it found too', /order-last sm:order-none basis-full/.test(dash), true)

console.log('\nthe charts are drawn to fit, not to a number')
for (const { f, src } of admin) {
  for (const m of src.matchAll(/<svg([^>]*)>/g)) {
    const a = m[1]
    if (!/viewBox/.test(a)) continue
    // An icon may be 16x16; a chart must be told to fill its box.
    if (/width="\d/.test(a) && Number((a.match(/width="(\d+)"/) || [])[1]) > 40) {
      check(`  ${f} chart scales`, false, true)
    }
  }
}
check('  every chart uses a viewBox and w-full', /viewBox=\{`0 0 \$\{W\} \$\{H\}`\} className="w-full/.test(dash), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
