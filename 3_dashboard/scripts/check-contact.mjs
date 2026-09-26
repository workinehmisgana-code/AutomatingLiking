// A phone number or a Telegram username, from everybody.
//
// Bank details say how to PAY somebody and the TikTok link says how to VERIFY
// them. Neither says how to REACH them: every question about a payment, a
// rejected link or a blocked account is asked over Telegram or a phone call,
// and an email address is not something these workers read. 114 accounts were
// registered before this was asked for, and all 114 had neither.
//
// EITHER ONE IS ENOUGH, which is the part most easily got wrong: some of these
// people have a phone and no Telegram and some the other way round, so
// demanding both would lock out people who can be contacted perfectly well.
//
// The two paths have to differ, too. A first-time visitor goes to the form.
// Somebody who registered weeks ago, has been working, and is now missing one
// new field gets a message and a button — dropping them into a form that asks
// for their bank account again reads as having been reset.
//
//   node scripts/check-contact.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const db = read('lib/db.ts')
const route = read('app/api/profile/route.ts')
const form = read('components/Onboarding.tsx')
const gate = read('components/ContactGate.tsx')
const page = read('app/page.tsx')

console.log('the column exists, and the old rows are NULL rather than empty')
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const cols = (
  await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_profile' AND column_name IN ('phone','telegram')
      ORDER BY column_name`
  )
).rows.map((r) => r.column_name)
check('  both columns', cols, ['phone', 'telegram'])
const counts = (
  await pool.query(
    `SELECT count(*)::int AS registered,
            count(*) FILTER (WHERE COALESCE(phone,'') <> ''
                                OR COALESCE(telegram,'') <> '')::int AS reachable
       FROM user_profile`
  )
).rows[0]
console.log(`   ${counts.registered} registered, ${counts.reachable} reachable, `
  + `${counts.registered - counts.reachable} will be asked`)
check('  the column is nullable, so nobody was invented a phone number',
      (await pool.query(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'user_profile' AND column_name = 'phone'`
      )).rows[0].is_nullable, 'YES')
await pool.end()

console.log('\nwhat counts as a phone number')
// Ethiopia writes the same number three ways and a form that rejects two of
// them is a form people give up on.
const phoneCases = [
  ['0912345678', '0912345678'],
  ['+251912345678', '+251912345678'],
  ['251 91 234 5678', '251912345678'],
  ['0912-345-678', '0912345678'],
  ['   ', null],
  ['12345', null],            // too short to be one
  ['not a number', null],
]
for (const [input, want] of phoneCases) {
  check(`  ${JSON.stringify(input)}`, normalizePhoneJS(input), want)
}

console.log('\nand what counts as a Telegram username')
const tgCases = [
  ['@misgana', 'misgana'],
  ['misgana', 'misgana'],
  ['https://t.me/misgana', 'misgana'],
  ['t.me/misgana', 'misgana'],
  ['ab', null],               // Telegram's own minimum is 5
  ['has spaces', null],
  ['', null],
]
for (const [input, want] of tgCases) {
  check(`  ${JSON.stringify(input)}`, normalizeTelegramJS(input), want)
}

console.log('\neither one is enough — that is the whole point')
check('  hasContact takes either', /p\.phone \?\? ''\)\.trim\(\) \|\| \(p\.telegram \?\? ''\)\.trim\(\)/.test(db), true)
check('  and the form says so', /either one is enough/i.test(form), true)
check('  the route too', /Either one is enough/.test(route), true)
check('  and refuses when neither is given', /!phone && !telegram/.test(route), true)
// Checked on the server as well as in the form: the form is not the only thing
// that can POST here, and a profile saved without either would pass the gate
// once and fail it forever after.
check('  the route validates, not just the form', /Enter a phone number or a Telegram username/.test(route), true)

console.log('\nnobody works without one')
check('  the profile is incomplete without it', /hasContact\(p\)\s*\n\s*\)/.test(db), true)
// Every earning API route goes through profileGate -> isProfileComplete.
check('  so every earning route is closed',
      /phone number or a Telegram username/.test(read('lib/profileGate.ts')), true)

console.log('\nbut an existing worker is told, not redirected')
check('  there is a separate state for it', /export function needsContactOnly/.test(db), true)
check('  the page shows the gate', /needsContactOnly\(profile\)/.test(page), true)
check('  before the redirect for new users',
      page.indexOf('needsContactOnly(profile)') < page.indexOf("redirect('/onboarding')"), true)
check('  with a message', /we need one more thing|One more thing/.test(gate), true)
check('  and a button to the form', /href="\/onboarding"/.test(gate), true)
// A worker who thinks they have been blocked stops working and does not come
// back, so the copy has to say this is a hold.
check('  saying nothing else has changed', /Nothing else has changed/.test(gate), true)
check('  and the form greets them differently',
      /Add your phone or Telegram/.test(form) && /Everything else is already filled in/.test(form),
      true)

console.log('\nand the details survive everything that writes a profile')
// The admin link editor and the block-remediation form both write a whole
// profile without ever asking about contacts. A plain overwrite would wipe the
// phone number of everyone whose link an admin corrected.
check('  the upsert COALESCEs them',
      /phone\s+= COALESCE\(EXCLUDED\.phone, user_profile\.phone\)/.test(db), true)
check('  and the telegram too',
      /telegram\s+= COALESCE\(EXCLUDED\.telegram, user_profile\.telegram\)/.test(db), true)
check('  the admin editor passes null deliberately',
      /phone: null, telegram: null/.test(read('app/api/admin/user-profile/route.ts')), true)
check('  remediation too',
      (read('app/api/profile/remediate/route.ts').match(/phone: null,/g) ?? []).length, 2)
// And the admin can see them, which is the entire reason for collecting them.
check('  the admin list carries them', /phone, telegram, referral_code/.test(db), true)

console.log('\nthe copies used above are still the real ones')
// The two normalisers are transcribed below so this script can run them without
// a TypeScript loader. Transcribed code rots silently, so the lines that do the
// work are compared against lib/db.ts: a change there fails here, rather than
// leaving a test that passes about code nobody runs.
const bodyOf = (src, name) => {
  const at = src.indexOf(`export function ${name}(`)
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
// Whitespace only. An earlier version stripped // comments too and quietly ate
// the `t.me//` in the Telegram regex — the comparison still passed, because it
// ate the same line on both sides, while no longer comparing it. Neither body
// has a comment in it, so there is nothing to strip.
const strip = (t) => t.replace(/\s+/g, ' ').trim()
for (const [name, mine] of [
  ['normalizePhone', String(normalizePhoneJS)],
  ['normalizeTelegram', String(normalizeTelegramJS)],
]) {
  const mineBody = mine.slice(mine.indexOf('{') + 1, mine.lastIndexOf('}'))
  check(`  ${name} still matches lib/db.ts`, strip(mineBody), strip(bodyOf(db, name)))
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)

// The two normalisers, transcribed from lib/db.ts; the parity check above fails
// if either drifts from it.
function normalizePhoneJS(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const plus = s.startsWith('+')
  const digits = s.replace(/\D/g, '')
  if (digits.length < 9 || digits.length > 15) return null
  return (plus ? '+' : '') + digits
}

function normalizeTelegramJS(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return null
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?t(elegram)?\.me\//i, '')
  s = s.replace(/^@/, '').split(/[?#/]/)[0]
  return /^[A-Za-z0-9_]{5,32}$/.test(s) ? s : null
}
