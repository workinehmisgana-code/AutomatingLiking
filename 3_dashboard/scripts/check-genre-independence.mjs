// Genres are independent: a replace upload and a block each touch one genre.
//
//   node scripts/check-genre-independence.mjs
//
// Static. Fails if an upload's replace stops being genre-scoped, if a block
// stops recording a genre, or if a serve path goes back to the any-genre list.
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
let bad = 0
const ok = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) bad++
}

const up = read('app/api/upload/route.ts')
ok(/!sameGenre\(v\) && !incomingKeys\.has\(urlKey\(v\)\)/.test(up), 'replace keeps other genres’ links')
ok(/\(sameGenre\(v\) \|\| incomingKeys\.has\(k\)\)/.test(up), 'replace only removes this genre’s links')

const db = read('lib/db.ts')
ok(db.includes('ADD COLUMN IF NOT EXISTS genre TEXT NOT NULL DEFAULT \'humanizer\''), 'blocked_link has a genre')
ok(db.includes('ADD PRIMARY KEY (url, genre)'), 'one block per (url, genre)')
ok(db.includes('INSERT INTO blocked_link (url, genre)'), 'every block records its genre')
ok(!/INSERT INTO blocked_link \(url\) /.test(db), 'no genre-less insert left')

for (const p of [
  'app/page.tsx',
  'app/api/app/links/route.ts',
  'app/api/app/status/route.ts',
  'app/api/admin/links/export/route.ts',
  'lib/recluster.ts',
  'app/api/admin/links/recluster/route.ts',
  'lib/categorise.ts',
  'app/api/admin/links/categorize/route.ts',
]) {
  const s = read(p)
  ok(s.includes('getBlockedPoolUrls') && !/\bgetBlockedUrls\b/.test(s), `${p} withholds per genre`)
}
ok(read('lib/verifyMerge.ts').includes("blocked.get(r.url)?.has(r.genre || DEFAULT_GENRE)"), 'merge checks the staged genre')
ok(read('app/api/admin/links/blocked/route.ts').includes('unblockLinks(urls, genre)'), 'unblock lifts one genre')

console.log(bad ? `\n${bad} failed` : '\nall good')
process.exit(bad ? 1 : 0)
