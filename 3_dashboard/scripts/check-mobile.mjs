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

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
