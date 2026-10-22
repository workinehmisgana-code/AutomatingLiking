// Nothing serves links to an account that has not passed the age check.
//
//   node scripts/run-ts-check.mjs scripts/check-verify-gate-covers.ts
//
// THERE ARE TWO FEEDS. The web dashboard builds one in app/page.tsx and the
// native app gets another from /api/app/links, and they share almost no code.
// A gate added to one of them looks finished and leaves the other wide open —
// which is exactly how it was: app/page.tsx held the worker while the app went
// on handing out links to the same person.
//
// So the check is structural: every door must have the gate on it, and a door
// added later must fail this rather than quietly serve.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()

let failures = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`)
}

function routesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name === 'route.ts') out.push(p)
    }
  }
  walk(dir)
  return out
}

async function main(): Promise<void> {
  const verify = readFileSync(join(ROOT, 'lib', 'tiktokVerify.ts'), 'utf8')
  const gate = readFileSync(join(ROOT, 'lib', 'profileGate.ts'), 'utf8')
  const appAuth = readFileSync(join(ROOT, 'lib', 'appAuth.ts'), 'utf8')
  const page = readFileSync(join(ROOT, 'app', 'page.tsx'), 'utf8')

  // ONE VERIFICATION. The link and click routes used to gate on the old
  // comment-validity table (isUserVerified) while the web page and the app's
  // sign-in used the account-age check — and nothing writes the old table, so
  // switching the gate on stopped every worker. No gate may read it.
  for (const r of ['app/api/app/links/route.ts', 'app/api/app/click/route.ts', 'app/api/clicks/route.ts']) {
    const src = readFileSync(join(ROOT, ...r.split('/')), 'utf8')
    check(`${r} gates on isTiktokVerified`, /VERIFY_GATE_ENABLED && !\(await isTiktokVerified\(/.test(src), true)
    check(`${r} does not gate on the old isUserVerified`, /isUserVerified\(/.test(src), false)
  }

  // The rule itself: too_new must not read as verified anywhere.
  console.log('a too-new account is not a verified one:')
  const { judge } = await import('../lib/tiktokVerify')
  const young = judge(
    { username: 'w', text: 'hi', likes: 0, uid: idFor(5), postedAt: null },
    new Date(),
    90
  )
  check('  judge says too_new', young.status, 'too_new')
  // The gate judges the stored creation date against TODAY's minimum, so an
  // account that passed under a lower setting is held until it is old enough.
  check('  and the gate judges age against the current minimum',
        gate.includes('verifiedNow(v, minAgeDays)'), true)
  const { verifiedNow } = await import('../lib/profileGate')
  const at = new Date('2026-10-20T00:00:00Z')
  const daysAgo = (d: number) => new Date(at.getTime() - d * 86_400_000).toISOString()
  check('  a 4-day-old account that once passed is not verified under 90',
        verifiedNow({ status: 'ok', accountAt: daysAgo(4) }, 90, at), false)
  check('  a 200-day-old passed account is',
        verifiedNow({ status: 'ok', accountAt: daysAgo(200) }, 90, at), true)
  check('  a too-new account that has since turned 90 days old is',
        verifiedNow({ status: 'too_new', accountAt: daysAgo(91) }, 90, at), true)
  check('  a comment that was never found is not',
        verifiedNow({ status: 'not_found', accountAt: daysAgo(400) }, 90, at), false)

  console.log('\nthe web feed is gated:')
  check('  app/page.tsx asks isTiktokVerified', /isTiktokVerified\(session\.user\.id\)/.test(page), true)
  check('  and holds them on the VerifyGate', /<VerifyGate/.test(page), true)

  console.log('\nthe session-authed earning routes are gated:')
  check('  profileGate refuses an unverified worker',
        /needsTiktokVerify/.test(gate), true)

  console.log('\nthe native app is gated at its one door:')
  check('  userIdFromApp checks it', /isTiktokVerified/.test(appAuth), true)
  check('  behind the same switch as everything else',
        /VERIFY_GATE_ENABLED/.test(appAuth), true)
  // FAILING OPEN HERE WOULD BE THE BUG. A database hiccup must hold the worker,
  // not wave them through.
  check('  and fails closed on an error', /catch\(\(\) => false\)\)\) return null/.test(appAuth), true)

  // EVERY app route must go through that door. One that reads the token itself
  // would bypass the gate entirely, and would look perfectly normal.
  console.log('\nand every app route actually uses that door:')
  const appRoutes = routesUnder(join(ROOT, 'app', 'api', 'app'))
  const bypass: string[] = []
  for (const f of appRoutes) {
    const t = readFileSync(f, 'utf8')
    const rel = f.slice(ROOT.length + 1)
    // A route that resolves a token without userIdFromApp is its own door.
    if (/getUserIdByAppToken/.test(t) && !/userIdFromApp/.test(t)) bypass.push(rel)
  }
  console.log(`  ${appRoutes.length} route(s) under /api/app`)
  check('  none resolves a token on its own', bypass, [])

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n')
  process.exitCode = failures ? 1 : 0
}

/** A snowflake id for an account created `daysAgo` days ago. */
function idFor(daysAgo: number): string {
  const secs = Math.floor((Date.now() - daysAgo * 86_400_000) / 1000)
  return (BigInt(secs) * BigInt(4294967296) + BigInt(1)).toString()
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
