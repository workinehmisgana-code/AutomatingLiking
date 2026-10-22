// Can an admin move a profile link that somebody else holds?
//
// A worker cannot: two profiles pointing at one TikTok account would let the same
// comments verify both, so self-service registration refuses a link already in
// use. An admin was refused by the same rule — and an admin editing a link is
// usually fixing exactly that situation: the worker re-registered, or two
// accounts were crossed, and the person who can see both profiles is the one
// entitled to say which is right.
//
// SKIPPING THE CHECK WOULD NOT HAVE WORKED. The uniqueness is a unique index on
// each *_url_norm column, so ignoring the app-level check only moves the refusal
// from a readable 409 to a 23505 out of Postgres. The link has to be TAKEN: the
// previous holder loses it, and is named in the reply, because taking somebody's
// account off their profile must never be silent.
//
//   node scripts/check-link-reassign.mjs
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
const admin = read('app/api/admin/user-profile/route.ts')
const selfRoute = read('app/api/profile/route.ts')
const ui = read('components/AdminDashboard.tsx')

console.log('the admin reassigns instead of being refused:')
check('  there is a release', /export async function releaseProfileLink/.test(db), true)
check('  it clears only the link', /SET \$\{col\} = NULL|SET \${col} = NULL/.test(db), true)
check('  and names who lost it', /RETURNING user_id, name/.test(db), true)
check('  the admin route calls it', /releaseProfileLink\(platform, url, userId\)/.test(admin), true)
check('  for all three platforms', /\['tiktok', next\.tiktok_url\]/.test(admin), true)
check('  before the write', admin.indexOf('releaseProfileLink') < admin.indexOf('upsertUserProfile('), true)
check('  and no longer refuses on conflict', /Already registered by another user/.test(admin), false)
check('  the reason is written down', /THE ADMIN REASSIGNS; A USER IS REFUSED/.test(admin), true)
check('  and why skipping the check would not work', /unique index/.test(db), true)

console.log('\nbut a worker still cannot take one:')
check('  registration checks conflicts', /findProfileLinkConflicts/.test(selfRoute), true)
check('  and the remediation form too',
      /findProfileLinkConflicts/.test(read('app/api/profile/remediate/route.ts')), true)

console.log('\nand the takeover is never silent:')
check('  the reply lists who lost it', /takenFrom/.test(admin), true)
check('  the page says so', /link was taken from/.test(ui), true)
check('  naming the platform and the person', /\$\{t\.platform\}/.test(ui) && /t\.name \|\| 'another user'/.test(ui), true)
check('  a real race still errors', /registered that .* link a moment ago|a moment ago/.test(admin), true)

// ── how often links actually collide, on the live rows ─────────────────────
const { Pool } = await import('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const { rows } = await pool
  .query(
    `SELECT count(*)::int profiles,
            count(tiktok_url_norm)::int with_tiktok,
            count(DISTINCT tiktok_url_norm)::int distinct_tiktok
       FROM user_profile`
  )
  .catch(() => ({ rows: [] }))
if (rows[0]) {
  const r = rows[0]
  console.log('\nprofiles now:')
  console.log(
    `   ${r.profiles} profile(s), ${r.with_tiktok} with a TikTok link, ` +
      `${r.distinct_tiktok} distinct — the index keeps those equal`
  )
}
await pool.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
