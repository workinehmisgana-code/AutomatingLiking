// Links and comments PER DAY, beside the totals, on every user row.
//
// A total cannot be compared between two workers. Measured on the real admin
// dashboard, two users sitting next to each other in the list:
//
//     5,984 clicks · counting from 2026-09-12 · 13 days · 460 a day
//     5,886 clicks · counting from 2026-08-12 · 44 days · 134 a day
//
// Almost the same total; one is working three and a half times as hard. The
// column that says so is the rate, and it only means anything if it divides by
// the right number of days.
//
// WHICH DAYS. Every count on that row is measured from GREATEST(the global
// reset, this user's own reset) — a worker reset individually last Tuesday has
// their totals counted over days, not weeks. A rate that divided those totals
// by the GLOBAL reset would report them at a third of their real output. And it
// can never start before the account existed: days nobody could have worked are
// not days.
//
//   node scripts/check-per-day.mjs
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const db = read('lib/db.ts')
const ui = read('components/AdminDashboard.tsx')

console.log('each row carries the day its counting starts')
check('  on the type', /countingFrom: string/.test(db), true)
check('  per user, not one for everybody', /const ownReset = new Map\(userResets\.map/.test(db), true)
check('  read from their own reset', /SELECT user_id, reset_at::date::text AS day FROM user_reset/.test(db), true)
// The three candidates, latest wins: the global reset, their own, and the day
// the account was created.
check('  the latest of the three', /\[resetDay, ownReset\.get\(u\.id\) \?\? '', \(u\.created_at \?\? ''\)\.slice\(0, 10\)\]/.test(db), true)
check('  and the reason is written down',
      /nobody could have worked/.test(db), true)

console.log('\nthe arithmetic')
// Transcribed from the component so the cases can actually be run; the parity
// check below fails if it drifts.
const daysSince = (fromISO) => {
  const from = new Date(`${fromISO}T00:00:00`)
  if (isNaN(from.getTime())) return 1
  const today = new Date()
  const days = Math.floor(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000
  ) + 1
  return Math.max(1, days)
}
const perDay = (total, days) => {
  const v = total / Math.max(1, days)
  return v >= 10 || Number.isInteger(v) ? Math.round(v).toLocaleString() : v.toFixed(1)
}
const iso = (d) => d.toISOString().slice(0, 10)
const today = new Date()
const ago = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n))

// INCLUSIVE. Somebody reset this morning has worked for one day, not zero — and
// dividing by zero puts Infinity on screen next to a person's name.
check('  reset today is one day', daysSince(ago(0)), 1)
check('  yesterday is two', daysSince(ago(1)), 2)
check('  a fortnight ago is 14', daysSince(ago(13)), 14)
check('  a date that is not one still divides by something', daysSince('not-a-date'), 1)
check('  a future date cannot make it zero', daysSince(iso(new Date(Date.now() + 864e5))), 1)
// The measured pair from the real dashboard.
check('  5,984 over 13 days', perDay(5984, 13), '460')
check('  5,886 over 44 days', perDay(5886, 44), '134')
// Small numbers keep a decimal; large ones do not, because 460.3 is noise.
check('  a small rate keeps its decimal', perDay(7, 4), '1.8')
check('  a whole one stays whole', perDay(8, 4), '2')
check('  nothing over any period is nothing', perDay(0, 30), '0')

console.log('\nand it is shown where the totals are')
check('  a clicks rate', /label="clicks\/day"/.test(ui), true)
check('  a comments rate', /label="comments\/day"/.test(ui), true)
check('  next to the totals they come from',
      ui.indexOf('label="clicked"') < ui.indexOf('label="clicks/day"'), true)
// The number alone does not say what it was divided by, and two admins would
// read it two ways.
check('  the chip can explain itself', /title\?: string/.test(ui), true)
check('  saying over how many days', /day\(s\), counting from/.test(ui), true)
// Calendar days are the headline; the active-day rate is the other honest
// reading and belongs beside it rather than instead of it.
check('  and what it is on the days they worked',
      /they actually signed in it is/.test(ui), true)

console.log('\nand each day table ends with its total')
// The total was computed here already — the Comments table needed it for the pay
// column — and was never shown, so "how much since their reset" meant adding up a
// row of numbers by eye.
check('  the header has a Total column', />\s*Total\s*</.test(ui), true)
check('  carrying the sum of the days', /\{total\.toLocaleString\(\)\}/.test(ui), true)
check('  set apart from the days', /border-l-2 border-t border-zinc-700 text-center tabular-nums font-semibold/.test(ui), true)
// Both tables, since DayTable renders both.
check('  on the clicks table', /<DayTable title="Clicks"/.test(ui), true)
check('  and the comments one', /<DayTable title="Comments"/.test(ui), true)
// Pay is derived from the total, so it stays after it.
check('  pay still comes last', ui.indexOf('Total') < ui.indexOf('Pay (birr)'), true)
// The tooltip carries the rate over the days that have a row, which is a
// different question from the chip's rate over every day since the reset.
check('  the total explains its rate', /a day on the days they worked/.test(ui), true)
check('  over the days with any activity', /over \$\{rows\.length\} day\(s\) with any/.test(ui), true)

console.log('\nthe copies used above are still the real ones')
const bodyOf = (src, name) => {
  const at = src.indexOf(`function ${name}(`)
  if (at < 0) return ''
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return ''
}
const strip = (t) => t.replace(/: string/g, '').replace(/: number/g, '').replace(/\s+/g, ' ').trim()
for (const [name, mine] of [['daysSince', daysSince], ['perDay', perDay]]) {
  const m = String(mine)
  const mineBody = m.slice(m.indexOf('{') + 1, m.lastIndexOf('}'))
  check(`  ${name} matches the component`, strip(mineBody), strip(bodyOf(ui, name)))
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
