// The password workers are told to set on the mailbox they create.
//
// It reaches three places and must read the same in all of them, or a worker
// follows the guide and is rejected by the reviewer: the task page, the guide
// in both languages, and the admin field that sets it.
//
// It is stored in the database, NOT written into the source. It is shown in
// full to every worker, so it is not a secret in any useful sense — but a
// literal password committed to a file outlives the reason for it and turns up
// in a repository search years later. This repo has already had a real .env in
// its history.
//
//   node scripts/check-account-password.mjs
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

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const stored = (
  await db.query("SELECT value FROM app_kv WHERE key = 'account_task_password'")
).rows[0]?.value

console.log('it is set, and it lives in the database:')
check('  a password is stored', typeof stored === 'string' && stored.length > 0, true)
console.log(`   currently: ${JSON.stringify(stored)}`)

// The one place it must NOT be.
const sources = [
  'lib/config.ts',
  'lib/db.ts',
  'components/AccountTaskClient.tsx',
  'components/AdminAccountTasks.tsx',
  'components/GuideContent.ts',
  'app/guide/page.tsx',
  'app/api/tasks/accounts/route.ts',
  'app/api/admin/tasks/accounts/route.ts',
]
const inSource = sources.filter((f) => stored && read(f).includes(stored))
check('  and nowhere in the source', inSource, [])
check(
  '  the only compiled-in value is an env fallback',
  /ACCOUNT_TASK_DEFAULT_PASSWORD = process\.env\.ACCOUNT_TASK_PASSWORD \?\? ''/.test(read('lib/config.ts')),
  true
)

console.log('\nevery surface reads that one value:')
const cfg = read('lib/config.ts')
const dbSrc = read('lib/db.ts')
check('  db getter falls back to the env var', /return \(saved \?\? ''\)\.trim\(\) \|\| ACCOUNT_TASK_DEFAULT_PASSWORD/.test(dbSrc), true)
check('  a password is trimmed, never lowercased', /const clean = String\(password \?\? ''\)\.trim\(\)/.test(dbSrc), true)
check("  the worker's endpoint sends it", /getAccountTaskPassword\(\)/.test(read('app/api/tasks/accounts/route.ts')), true)
check('  the task page shows it', /Set this exact password on the mailbox/.test(read('components/AccountTaskClient.tsx')), true)
check('  with a copy button', /navigator\.clipboard\?\.writeText\(data\.password\)/.test(read('components/AccountTaskClient.tsx')), true)
check('  the admin can change it', /setAccountTaskPassword\(b\.password\)/.test(read('app/api/admin/tasks/accounts/route.ts')), true)
check('  and sees a field for it', /Password workers must set on the mailbox/.test(read('components/AdminAccountTasks.tsx')), true)

console.log('\nthe guide says it in BOTH languages, or in neither:')
const guide = read('components/GuideContent.ts')
check('  the prop exists', /accountPassword: string/.test(guide), true)
check('  english', /Set the password to exactly \$\{p\.accountPassword\}/.test(guide), true)
check('  amharic', /የይለፍ ቃሉን በትክክል \$\{p\.accountPassword\}/.test(guide), true)
check('  both behind the same blank-check', (guide.match(/p\.accountPassword\s*$/gm) ?? []).length, 2)
check('  and the guide page supplies it', /accountPassword=\{accountPassword\}/.test(read('app/guide/page.tsx')), true)

console.log('\na blank password means the instruction disappears, not an empty box:')
// Both guide branches and the page block are conditional on a non-empty value.
check('  the task page hides the block', /\{data\.password && \(/.test(read('components/AccountTaskClient.tsx')), true)
check('  the guide omits the sentence', (guide.match(/p\.accountPassword\s*\n\s*\? `/g) ?? []).length, 2)

// What a worker is told, rendered for real, so the instruction can be read.
console.log('\nwhat a worker is told, end to end:')
const domain = (await db.query("SELECT value FROM app_kv WHERE key = 'account_task_domain'"))
  .rows[0]?.value
await db.end()
console.log(`   create an address ending @${domain || '(no domain set yet)'}`)
console.log(`   set its password to exactly: ${stored}`)
check('  a domain is set too, or the task cannot be done', !!domain, true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
