// Why a wrong title stays wrong however often you refetch it.
//
// Admin → Links → ⚙ Process reads each video's caption from TikTok's oEmbed, in
// the BROWSER, because TikTok blocks Vercel's datacenter IP but allows a
// residential one. oEmbed rate-limits that IP: ask it for a page of 500 links
// with five workers and it answers
//
//     ratelimit triggered            HTTP 429
//
// for every one of them. The client tested `if (r.ok)` and otherwise did
// nothing at all — no retry, no count, no message — so the stored title was
// kept, the button finished, and a title that was wrong stayed wrong.
//
// Confirmed live from this machine against the link that prompted this:
// @ethio_computer_school/photo/7622551066676120853 — 429 on both the /photo/ and
// the rewritten /video/ form, minutes apart.
//
//   node scripts/check-title-refetch.mjs           (offline: the rules)
//   node scripts/check-title-refetch.mjs --live    (also asks oEmbed once)
import { readFileSync } from 'node:fs'

let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const ui = readFileSync(new URL('../components/AdminLinks.tsx', import.meta.url), 'utf8')

console.log('a refused fetch is counted, not swallowed:')
check('  rate limits are counted apart', /if \(lastStatus === 429\) limited\+\+/.test(ui), true)
check('  everything else is counted too', /else failed\+\+/.test(ui), true)
check('  and the press says so', /Refetched \$\{read\} of \$\{asked\} title\(s\)/.test(ui), true)
check('  naming the limit by its status', /rate limit \(HTTP 429\)/.test(ui), true)
// The distinction is the useful part: one is worth waiting out, the other is not.
check('  waiting is suggested only for the limit',
      /That is per IP and it lasts minutes/.test(ui), true)
check('  and a dead video is called a dead video',
      /deleted, private, or a /.test(ui), true)

console.log('\nand it stops provoking the limit so hard:')
check('  three workers, not five', /Math\.min\(3, tiktoks\.length\)/.test(ui), true)
check('  with a backoff between tries', /await sleep\(2000 \* \(attempt \+ 1\) \* \(attempt \+ 1\)\)/.test(ui), true)
check('  up to three attempts', /attempt < 3 && !got/.test(ui), true)
// Asking again just to find out why would spend a request on the very limit
// that is the problem.
check('  the reason is remembered, not re-asked', /let lastStatus = 0/.test(ui), true)

console.log('\nthe rest of the refetch is unchanged:')
check('  photo posts are asked for as /video/', /l\.url\.replace\('\/photo\/', '\/video\/'\)/.test(ui), true)
check('  the selection decides what is refetched',
      /selected\.size > 0 \? shown\.filter\(\(l\) => selected\.has\(l\.url\)\) : shown/.test(ui), true)
check('  and what comes back overwrites the cache',
      /const fresh = \{ \.\.\.serverTitles, \.\.\.tkTitles \}/.test(ui), true)

// ── ask TikTok, if asked to ────────────────────────────────────────────────
if (process.argv.includes('--live')) {
  const url = 'https://www.tiktok.com/@ethio_computer_school/video/7622551066676120853'
  console.log('\nasking oEmbed once, from this machine:')
  try {
    const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`)
    const body = (await r.text()).slice(0, 120)
    console.log(`   HTTP ${r.status}: ${body}`)
    if (r.status === 429) {
      console.log('   → this IP is rate-limited right now, which is exactly the')
      console.log('     state in which a refetch silently changed nothing.')
    }
  } catch (e) {
    console.log(`   request failed: ${e.message}`)
  }
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
