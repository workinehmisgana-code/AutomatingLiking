// Who has to resubmit their TikTok profile link.
//
// The link has to be https://www.tiktok.com/@username, because everything that
// judges a person's work reads the @username out of that one string — the
// verification gate, the comment-presence scan, handleFromProfile(). A stored
// link without an @ in it means that person can never be matched to a comment
// they actually wrote.
//
// This reports who is affected and tidies the links that are only cosmetically
// wrong. It is two different jobs on purpose:
//
//   a link that NAMES the account      (no https://, a trailing slash, TikTok's
//                                       own ?_t=…&_r=1, odd case)
//     → canonicalised in place. Nobody needs to be asked for a link we can
//       already read; --apply writes the tidy form.
//
//   a link that does NOT name it       (no @, a video URL, vm.tiktok.com)
//     → listed. Only the person can fix it, so they are held at a gate on
//       their next visit and asked to paste it again. Nothing is deleted.
//
//   node scripts/check-tiktok-format.mjs            report only
//   node scripts/check-tiktok-format.mjs --apply    tidy the fixable ones
//   node scripts/check-tiktok-format.mjs --self     just test the rule, no DB
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const SELF = args.includes('--self')

// ── the rule, copied from lib/config.ts ─────────────────────────────────────
// Copied rather than imported because this is a plain .mjs script and that is a
// TypeScript module. The self-test below is what keeps the copy honest: if the
// two ever disagree about a case, one of these assertions is the thing that
// says so.
const HANDLE = /^[a-zA-Z0-9._]{2,24}$/

// normalizeProfileUrl from lib/db.ts. tiktok_url_norm is maintained by the app,
// not by the database, so an UPDATE that touches the url has to write it too.
function normalizeProfileUrl(raw) {
  let s = String(raw ?? '').trim()
  if (!s) return null
  s = s.toLowerCase()
  s = s.replace(/^https?:\/\//, '')
  s = s.replace(/^www\./, '')
  s = s.split(/[?#]/)[0]
  s = s.replace(/\/+$/, '')
  return s || null
}

function canonicalTiktokProfile(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return null
  let url
  try {
    url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase()
  if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 1) return null
  const first = decodeURIComponent(parts[0])
  if (!first.startsWith('@')) return null
  const handle = first.slice(1)
  if (!HANDLE.test(handle)) return null
  return { url: `https://www.tiktok.com/@${handle}`, handle: handle.toLowerCase() }
}

// ── the rule's own cases ────────────────────────────────────────────────────
const GOOD = [
  ['https://www.tiktok.com/@abebe', 'https://www.tiktok.com/@abebe'],
  // Written casually. Each of these names the account without ambiguity, so it
  // is tidied rather than bounced.
  ['tiktok.com/@abebe', 'https://www.tiktok.com/@abebe'],
  ['https://tiktok.com/@abebe/', 'https://www.tiktok.com/@abebe'],
  ['https://www.tiktok.com/@abebe?_t=ZM-123&_r=1', 'https://www.tiktok.com/@abebe'],
  ['  HTTPS://WWW.TIKTOK.COM/@Abebe  ', 'https://www.tiktok.com/@Abebe'],
  ['https://www.tiktok.com/@a.b_c99', 'https://www.tiktok.com/@a.b_c99'],
  ['https://www.tiktok.com/@abebe#foo', 'https://www.tiktok.com/@abebe'],
]

const BAD = [
  '',
  'abebe',
  'https://www.tiktok.com/abebe', // no @: handleFromProfile returns null
  'https://www.tiktok.com/@abebe/video/7596784835159444767',
  'https://www.tiktok.com/t/ZTabc123',
  'https://vm.tiktok.com/ZMabc123',
  'https://vt.tiktok.com/ZSabc123',
  'https://www.tiktok.com/',
  'https://www.tiktok.com/@', // an @ and nothing after it
  'https://www.instagram.com/@abebe',
  'https://www.tiktok.com/@a', // one character, under TikTok's minimum
  'not a url at all',
]

// Why a link cannot be used, in the words you would say to the person. Only
// reached for links the rule rejects.
function reasonFor(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return 'empty'
  let host = ''
  try {
    host = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase()
  } catch {
    return 'not a link at all'
  }
  if (!host.endsWith('tiktok.com')) return 'not a TikTok link'
  if (host !== 'tiktok.com' && host !== 'www.tiktok.com') {
    return 'short link \u2014 the username is behind a redirect'
  }
  if (/\/(video|photo)\//i.test(v)) return 'a video, not the account'
  if (/tiktok\.com\/t\//i.test(v)) return 'share link \u2014 no username in it'
  if (!v.includes('@')) return 'missing the @ \u2014 otherwise it looks right'
  return 'not a single @username'
}

let failed = 0
for (const [input, want] of GOOD) {
  const got = canonicalTiktokProfile(input)
  if (got?.url !== want) {
    console.log(`FAIL accepted-as: ${JSON.stringify(input)} -> ${got?.url ?? 'null'} (want ${want})`)
    failed++
  }
}
for (const input of BAD) {
  const got = canonicalTiktokProfile(input)
  if (got) {
    console.log(`FAIL should-reject: ${JSON.stringify(input)} -> ${got.url}`)
    failed++
  }
}
// needsTiktokProfileFix in lib/db.ts: a person is STOPPED only when the link
// cannot be read. The 106 whose links merely carry TikTok's share parameters
// are canonicalised on save and must never see the gate \u2014 asking them to
// resubmit a link that already names their account would be a cost paid by them
// for a tidiness we can apply ourselves.
const stopped = (url) => String(url ?? '').trim().length > 0 && canonicalTiktokProfile(url) === null
for (const [input] of GOOD) {
  if (stopped(input)) {
    console.log(`FAIL would-stop: ${JSON.stringify(input)} names an account`)
    failed++
  }
}
for (const input of BAD) {
  // An EMPTY link is not this gate's business \u2014 that person has not finished
  // registering, and isProfileComplete sends them to the form instead.
  if (input !== '' && !stopped(input)) {
    console.log(`FAIL would-pass: ${JSON.stringify(input)} names no account`)
    failed++
  }
}
if (stopped('')) {
  console.log('FAIL would-stop: an empty link is incomplete registration, not a bad format')
  failed++
}

console.log(
  failed === 0
    ? `Rule: ${GOOD.length} accepted and ${BAD.length} rejected, and the gate stops exactly the unreadable ones.`
    : `Rule: ${failed} case(s) wrong.`
)
if (failed) process.exit(1)
if (SELF) process.exit(0)

// ── the stored links ────────────────────────────────────────────────────────
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

try {
  const { rows } = await db.query(
    `SELECT p.user_id, p.name, p.tiktok_url, p.phone, p.telegram, u.email
       FROM user_profile p
       LEFT JOIN "user" u ON u.id = p.user_id
      WHERE coalesce(p.tiktok_url, '') <> ''
      ORDER BY p.name`
  )

  const tidy = []   // we can read the account: fixable here
  const ask = []    // we cannot: only the person can fix it
  for (const r of rows) {
    const c = canonicalTiktokProfile(r.tiktok_url)
    if (!c) ask.push(r)
    else if (c.url !== r.tiktok_url) tidy.push({ ...r, fixed: c.url })
  }

  console.log(`\n${rows.length.toLocaleString()} profile(s) with a TikTok link.`)
  console.log(`  ${(rows.length - tidy.length - ask.length).toLocaleString()} already exact`)
  console.log(`  ${tidy.length.toLocaleString()} tidy-able here (the account is readable)`)
  console.log(`  ${ask.length.toLocaleString()} must be resubmitted by the person`)

  if (tidy.length) {
    console.log('\nTidy-able:')
    for (const r of tidy.slice(0, 40)) {
      console.log(`  ${(r.name || r.email || r.user_id).padEnd(24)} ${r.tiktok_url}\n  ${''.padEnd(24)} -> ${r.fixed}`)
    }
    if (tidy.length > 40) console.log(`  … and ${tidy.length - 40} more`)
  }

  if (ask.length) {
    const byReason = {}
    for (const r of ask) {
      const k = reasonFor(r.tiktok_url)
      byReason[k] = (byReason[k] ?? 0) + 1
    }
    console.log('\nWhy they cannot be read:')
    for (const [k, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${k}`)
    }
    console.log('\nMust resubmit (they will be asked on their next visit):')
    for (const r of ask) {
      const reach = r.phone || (r.telegram ? `@${r.telegram}` : '') || r.email || '(no contact)'
      console.log(`  ${(r.name || '(no name)').padEnd(24)} ${String(r.tiktok_url).slice(0, 70)}`)
      console.log(`  ${''.padEnd(24)} ${reasonFor(r.tiktok_url)}`)
      console.log(`  ${''.padEnd(24)} reach on: ${reach}`)
    }
  }

  if (!APPLY) {
    console.log(
      tidy.length
        ? '\nNothing written. Re-run with --apply to tidy the readable ones.'
        : '\nNothing to tidy.'
    )
  } else if (tidy.length) {
    let n = 0
    for (const r of tidy) {
      // tiktok_url_norm written alongside, because the app maintains it rather
      // than the database. It should come out identical — normalizeProfileUrl
      // strips the scheme, www., the query and the trailing slash too, which is
      // most of what tidying removes — so this cannot make a link that was
      // unique collide with another. Recomputed rather than assumed.
      const norm = normalizeProfileUrl(r.fixed)
      if (norm !== normalizeProfileUrl(r.tiktok_url)) {
        console.log(`  skipped ${r.name || r.user_id}: tidying would change its identity`)
        continue
      }
      await db.query(
        'UPDATE user_profile SET tiktok_url = $2, tiktok_url_norm = $3, updated_at = now() WHERE user_id = $1',
        [r.user_id, r.fixed, norm]
      )
      n++
    }
    console.log(`\nTidied ${n.toLocaleString()} link(s).`)
  }
} finally {
  await db.end()
}
