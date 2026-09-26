// The recovery address workers are told to put on the mailbox they create.
//
// It reaches the same three places as the password and must read the same in
// all of them, or a worker follows the guide and is rejected by the reviewer:
// the task page, the guide in both languages, and the admin field that sets it.
//
// UNLIKE the password, it IS written into the source. It is not a credential —
// it is where the provider sends a reset link — and the point of it is that the
// address is ours. A mailbox whose recovery address belongs to the worker is one
// we can be locked out of the day they change their mind, which is the opposite
// of what the task is for. The database and the env var can still override it,
// so it can be changed without a deploy.
//
//   node scripts/check-account-recovery.mjs
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

const cfg = read('lib/config.ts')
const dbSrc = read('lib/db.ts')
const taskPage = read('components/AccountTaskClient.tsx')
const adminPage = read('components/AdminAccountTasks.tsx')
const guide = read('components/GuideContent.ts')

console.log('the address is compiled in, and overridable:')
check(
  '  the default is the company address',
  /ACCOUNT_TASK_DEFAULT_RECOVERY =\s*\n\s*process\.env\.ACCOUNT_TASK_RECOVERY \?\? 'workinehmisgana@gmail\.com'/.test(cfg),
  true
)
check('  an env var can replace it', /process\.env\.ACCOUNT_TASK_RECOVERY/.test(cfg), true)
check('  and the database wins over both',
      /return \(saved \?\? ''\)\.trim\(\) \|\| ACCOUNT_TASK_DEFAULT_RECOVERY/.test(dbSrc), true)
// An address is not case-sensitive in practice, and two spellings of one would
// read as a change when it is not.
check('  it is stored lowercased',
      /const clean = String\(email \?\? ''\)\.trim\(\)\.toLowerCase\(\)/.test(dbSrc), true)
check('  under its own key', /'account_task_recovery'/.test(dbSrc), true)

console.log('\nevery surface reads that one value:')
check("  the worker's endpoint sends it",
      /getAccountTaskRecovery\(\)/.test(read('app/api/tasks/accounts/route.ts')), true)
check('  the task page shows it',
      /Set this as the recovery email on the mailbox/.test(taskPage), true)
check('  with a copy button',
      /navigator\.clipboard\?\.writeText\(data\.recovery\)/.test(taskPage), true)
// The one thing a worker might get wrong by doing the obvious thing.
check('  and says it is not their own address', /Not your own address/.test(taskPage), true)
check('  the admin can change it',
      /setAccountTaskRecovery\(b\.recovery\)/.test(read('app/api/admin/tasks/accounts/route.ts')), true)
check('  and sees a field for it',
      /Recovery email workers must put on the mailbox/.test(adminPage), true)
check('  which explains why it must be ours',
      /locked out of the day they change their mind/.test(adminPage), true)

console.log('\nthe guide says it in BOTH languages, or in neither:')
check('  the prop exists', /accountRecovery: string/.test(guide), true)
check('  english', /Put \$\{p\.accountRecovery\} as the recovery email/.test(guide), true)
check('  amharic', /\(recovery\) ኢሜይል \$\{p\.accountRecovery\}/.test(guide), true)
check('  both behind the same blank-check',
      (guide.match(/p\.accountRecovery\s*$/gm) ?? []).length, 2)
check('  and the guide page supplies it',
      /accountRecovery=\{accountRecovery\}/.test(read('app/guide/page.tsx')), true)

console.log('\na blank address means the instruction disappears, not an empty box:')
check('  the task page hides the block', /\{data\.recovery && \(/.test(taskPage), true)
check('  the guide omits the sentence',
      (guide.match(/p\.accountRecovery\s*\n\s*\? `/g) ?? []).length, 2)

console.log('\nwhat a worker is told, end to end:')
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const stored = (
  await db.query("SELECT value FROM app_kv WHERE key = 'account_task_recovery'")
).rows[0]?.value
const domain = (await db.query("SELECT value FROM app_kv WHERE key = 'account_task_domain'"))
  .rows[0]?.value
const password = (await db.query("SELECT value FROM app_kv WHERE key = 'account_task_password'"))
  .rows[0]?.value
await db.end()

// Nothing saved is the normal state: the compiled-in default is the answer
// until an admin changes it, which is why it is compiled in.
const shown = (stored ?? '').trim() ||
  (cfg.match(/ACCOUNT_TASK_RECOVERY \?\? '([^']+)'/) ?? [])[1]
console.log(`   create an address ending @${domain || '(no domain set yet)'}`)
console.log(`   set its password to exactly: ${password ?? '(none set)'}`)
console.log(`   set its recovery email to:   ${shown}`)
check('  a recovery address is what the worker will see', /@/.test(shown || ''), true)
check('  and it is not the default being blank', !!shown, true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
