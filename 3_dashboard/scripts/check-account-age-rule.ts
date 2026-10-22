// The three-month rule, and the ways it could quietly reject the wrong people.
//
//   node scripts/run-ts-check.mjs scripts/check-account-age-rule.ts
//
// No network: the decision is pure, and that is the point of having judge() as
// its own function. What is being checked is not "can we read TikTok" (the
// probe script does that) but "given a comment, do we reach the right verdict".
import { accountCreatedAt } from '../lib/tiktokId'

let failures = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`)
}

/** A snowflake id for an account created `daysAgo` days ago. */
function idFor(daysAgo: number): string {
  const secs = Math.floor((Date.now() - daysAgo * 86_400_000) / 1000)
  return (BigInt(secs) * BigInt(4294967296) + BigInt(12345)).toString()
}

async function main(): Promise<void> {
  const { judge, handleOf, VERIFY_MIN_AGE_DAYS } = await import('../lib/tiktokVerify')
  // The text is irrelevant to the verdict now, which is the point: a comment
  // from their handle is the proof, whatever it says.
  const comment = (uid: string, text = 'hello') => ({
    username: 'worker1',
    text,
    likes: 0,
    uid,
    postedAt: new Date().toISOString(),
  })

  console.log(`the floor is ${VERIFY_MIN_AGE_DAYS} days\n`)

  console.log('an account old enough passes:')
  check('  two years old', judge(comment(idFor(730))).status, 'ok')
  check('  a day over the floor', judge(comment(idFor(VERIFY_MIN_AGE_DAYS + 1))).status, 'ok')

  console.log('\nand a young one does not:')
  check('  a week old', judge(comment(idFor(7))).status, 'too_new')
  check('  a day under the floor', judge(comment(idFor(VERIFY_MIN_AGE_DAYS - 1))).status, 'too_new')
  const young = judge(comment(idFor(10)))
  check('  and the message says how old it is', /10 day/.test(young.message), true)
  check('  and names the floor', new RegExp(String(VERIFY_MIN_AGE_DAYS)).test(young.message), true)

  // THE ONE THAT WOULD BE BACKWARDS. A pre-snowflake id belongs to an account
  // from before the scheme existed - the OLDEST accounts there are. Reading
  // "does not decode" as "too new" would reject exactly the people this rule
  // is meant to welcome, and it would look like the rule working.
  console.log('\nan id that does not decode is an OLD account, not a young one:')
  check('  pre-snowflake id passes', judge(comment('12345')).status, 'ok')
  check('  with no age claimed', judge(comment('12345')).ageDays, null)
  check('  a non-numeric id passes too', judge(comment('abc')).status, 'ok')
  check('  accountCreatedAt agrees it is undatable', accountCreatedAt('12345'), null)

  // WHAT THEY WROTE DOES NOT DECIDE ANYTHING. The name was required once and
  // it only ever produced false rejections: someone who wrote a greeting, or
  // their name spelled differently, was sent back to edit a comment that was
  // already proof. The handle is the proof.
  console.log('\nthe text of the comment is not a test:')
  check('  a name', judge(comment(idFor(730), 'Abebe Kebede')).status, 'ok')
  check('  somebody else\u2019s name', judge(comment(idFor(730), 'Selam')).status, 'ok')
  check('  an emoji', judge(comment(idFor(730), '\u2764\ufe0f')).status, 'ok')
  check('  nothing at all', judge(comment(idFor(730), '')).status, 'ok')
  check('  and a young account is still refused whatever it says',
        judge(comment(idFor(5), 'Abebe Kebede')).status, 'too_new')

  // THE FLOOR IS A SETTING NOW, so the same comment has to reach different
  // verdicts under different floors — otherwise the admin control is a box
  // that stores a number nothing reads.
  console.log('\nthe floor is a parameter, not a constant:')
  check('  90 days old passes a 30-day floor',
        judge(comment(idFor(90)), new Date(), 30).status, 'ok')
  check('  and fails a 180-day floor',
        judge(comment(idFor(90)), new Date(), 180).status, 'too_new')
  check('  a floor of 0 lets a day-old account through',
        judge(comment(idFor(1)), new Date(), 0).status, 'ok')
  check('  the message quotes the floor in force',
        /180 days/.test(judge(comment(idFor(90)), new Date(), 180).message), true)
  // An undatable id is still an OLD account, whatever the floor is set to.
  check('  a pre-snowflake id passes even a huge floor',
        judge(comment('12345'), new Date(), 3650).status, 'ok')

  console.log('\nthe handle is read from whatever shape the profile is in:')
  check('  full url', handleOf('https://www.tiktok.com/@worker1'), 'worker1')
  check('  with a trailing slash', handleOf('https://www.tiktok.com/@worker1/'), 'worker1')
  check('  bare @handle', handleOf('@Worker1'), 'worker1')
  check('  bare handle', handleOf('Worker1'), 'worker1')
  check('  nothing', handleOf(''), '')
  check('  null', handleOf(null), '')

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n')
  process.exitCode = failures ? 1 : 0
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
