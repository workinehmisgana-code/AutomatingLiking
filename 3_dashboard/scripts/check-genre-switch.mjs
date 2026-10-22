// The admin master genre switch reaches every genre-shaped page.
//
//   node scripts/check-genre-switch.mjs
//
// Static: no DB, no server. Fails if a page stops reading the switch, or if a
// page grows its own "All genres" dropdown again beside it (two genre controls
// on one screen that can disagree is the thing the switch replaced).
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
let bad = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) bad++
}

ok(read('app/admin/layout.tsx').includes('<GenreSwitch'), 'admin layout renders the switch')
for (const p of [
  'app/admin/page.tsx',
  'app/admin/links/page.tsx',
  'app/admin/verify-links/page.tsx',
  'app/admin/comments/[product]/page.tsx',
  'app/admin/promo/page.tsx',
]) {
  ok(read(p).includes('getAdminGenre()'), `${p} reads the switch`)
}
for (const c of ['components/AdminLinks.tsx', 'components/VerifyLinks.tsx', 'components/AdminDashboard.tsx']) {
  ok(!/<option value="">All genres<\/option>/.test(read(c)), `${c} has no page-level genre dropdown`)
}
ok(read('lib/db.ts').includes('getClickAggregates(resetAt, genreProducts)'), 'click totals are cut to the genre')

// Every admin API that works over links reads the switch itself, so a page
// cannot forget to send it.
for (const p of [
  'app/api/admin/links/list/route.ts',
  'app/api/admin/links/comment-dates/route.ts',
  'app/api/admin/links/comment-tally/route.ts',
  'app/api/admin/links/scan-comments/route.ts',
  'app/api/admin/links/scan-history/route.ts',
  'app/api/admin/links/broken/route.ts',
  'app/api/admin/links/refresh-stats/route.ts',
  'app/api/admin/links/comment-yield/route.ts',
  'app/api/admin/links/rank-only-channels/route.ts',
  'app/api/admin/links/channel-stats/route.ts',
  'app/api/admin/links/export/route.ts',
  'app/api/admin/verify-links/accounts/route.ts',
  'app/api/admin/verify-links/merge/route.ts',
  'app/api/admin/verify-links/extract/route.ts',
  'app/api/admin/verify-links/channels/route.ts',
  'app/api/admin/replies/route.ts',
  'app/api/admin/comment-presence/user/route.ts',
  'app/api/admin/user-clicks/route.ts',
  'app/admin/liker/page.tsx',
]) {
  ok(/getAdminGenre|adminGenreUrlTest/.test(read(p)), `${p} follows the switch`)
}
ok(read('lib/adminLinks.ts').includes('`${r.platform}|${r.genre}`'), 'Links-page clusters are per genre, like the feeds')
ok(read('lib/replyGen.ts').includes('genreOfProduct(p) === genre'), 'replies only recommend the genre’s products')
ok(!/<option value="">All genres<\/option>/.test(read('components/LikerSettings.tsx')), 'liker genre comes from the switch')

console.log(bad ? `\n${bad} failed` : '\nall good')
process.exit(bad ? 1 : 0)
