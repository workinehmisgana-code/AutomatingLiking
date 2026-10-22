/**
 * Does the genre mix actually come out of the feed in the ratio it was set to?
 *
 * The scheduler is a few lines of arithmetic that decide what every worker sees
 * next, and getting it wrong is silent: a ratio that never reaches cocodly looks
 * exactly like a cocodly pool that is empty. So it is measured rather than read.
 *
 * TypeScript, not .mjs like its neighbours, because it tests the REAL functions
 * instead of a copy of them — a copied scheduler would agree with itself for
 * ever. There is no TS runner in this project, so it is compiled first:
 *
 *   npx tsc scripts/check-genre-feed.ts lib/userFeed.ts lib/config.ts lib/cluster.ts \
 *       --outDir .checkbuild --module commonjs --target es2020 --skipLibCheck \
 *   && node .checkbuild/scripts/check-genre-feed.js
 *
 * (scripts/run-genre-feed-check.mjs does both and cleans up after itself.)
 */
import { buildUserFeed, interleaveByWeight } from '../lib/userFeed'
import { DEFAULT_GENRE, GENRES, genreWeights, clampGenreShare } from '../lib/config'

let fails = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(
    `   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}` +
      (ok ? '' : ` (want ${JSON.stringify(want)})`)
  )
}

// ── the shares ──────────────────────────────────────────────────────────────
console.log('three numbers become three weights:')
check('  60/20/20 normalises', genreWeights({ humanizer: 60, website: 20, slides: 20 }), {
  humanizer: 0.6,
  website: 0.2,
  slides: 0.2,
})
// NOT VALIDATED, NORMALISED. 60/20/15 plainly means the same split as 63/21/16,
// and a box that refuses to save it is a box people fight.
const odd = genreWeights({ humanizer: 60, website: 20, slides: 15 })
check('  they need not total 100', Math.round(odd.humanizer * 1000) / 1000, 0.632)
check('  nothing set falls back to the default', genreWeights(null), {
  humanizer: 1,
  website: 0,
  slides: 0,
})
check('  all zero falls back too, rather than serving nothing',
  genreWeights({ humanizer: 0, website: 0, slides: 0 }).humanizer, 1)
check('  a share is whole percent, 0..100',
  [clampGenreShare(-5), clampGenreShare(101), clampGenreShare('42.6'), clampGenreShare('')],
  [0, 100, 43, 0])

// ── the scheduler ───────────────────────────────────────────────────────────
console.log('\nthe list comes out in the ratio it was asked for:')
const lists = new Map<string, string[]>([
  ['humanizer', Array.from({ length: 100 }, (_, i) => `h${i}`)],
  ['website', Array.from({ length: 100 }, (_, i) => `w${i}`)],
  ['slides', Array.from({ length: 100 }, (_, i) => `s${i}`)],
])
const w = genreWeights({ humanizer: 60, website: 20, slides: 20 })
const mixed = interleaveByWeight(lists, w, 100)
const tally = (xs: string[]) => ({
  h: xs.filter((x) => x[0] === 'h').length,
  w: xs.filter((x) => x[0] === 'w').length,
  s: xs.filter((x) => x[0] === 's').length,
})
check('  100 links at 60/20/20', tally(mixed), { h: 60, w: 20, s: 20 })
check('  and the length is the limit', mixed.length, 100)
// Interleaved, not three blocks: a worker scrolling must not meet sixty
// humanizer links before the first cocodly one.
const firstTwenty = tally(mixed.slice(0, 20))
check('  every genre appears in the first twenty', firstTwenty.w > 0 && firstTwenty.s > 0, true)
check('  and roughly in share there too', firstTwenty.h >= 10 && firstTwenty.h <= 14, true)

console.log('\na genre that runs dry yields its slots:')
const thin = new Map<string, string[]>([
  ['humanizer', Array.from({ length: 100 }, (_, i) => `h${i}`)],
  ['website', ['w0', 'w1', 'w2']],
  ['slides', []],
])
const filled = interleaveByWeight(thin, w, 50)
check('  the list is still full', filled.length, 50)
check('  cocodly gave what it had', tally(filled).w, 3)
check('  and humanizer covered the rest', tally(filled).h, 47)

console.log('\na genre with a zero share is never served:')
const zero = genreWeights({ humanizer: 100, website: 0, slides: 0 })
check('  nothing from the others', tally(interleaveByWeight(lists, zero, 40)), { h: 40, w: 0, s: 0 })

// ── through the real feed ───────────────────────────────────────────────────
console.log('\nand the same through buildUserFeed, with its clustering:')
type Row = { url: string; platform: string; genre?: string; search_rank?: number }
const pool: Row[] = []
for (let i = 0; i < 300; i++) pool.push({ url: `https://t/h${i}`, platform: 'tiktok', genre: 'humanizer', search_rank: i + 1 })
for (let i = 0; i < 300; i++) pool.push({ url: `https://t/w${i}`, platform: 'tiktok', genre: 'website', search_rank: i + 1 })
for (let i = 0; i < 300; i++) pool.push({ url: `https://t/s${i}`, platform: 'tiktok', genre: 'slides', search_rank: i + 1 })

const { served } = buildUserFeed(pool, new Set<string>(), 100, w)
const kinds = {
  h: served.filter((v) => v.genre === 'humanizer').length,
  w: served.filter((v) => v.genre === 'website').length,
  s: served.filter((v) => v.genre === 'slides').length,
}
check('  100 served at 60/20/20', kinds, { h: 60, w: 20, s: 20 })

// EACH GENRE IS CLUSTERED WITHIN ITSELF. A cluster is relative to the pool it
// was computed over, so mixing first and clustering after would spread the 300
// website links across the humanizer ranking and call the result cluster 1.
// chunk() in userFeed is 0-BASED (assignClusters in adminLinks is 1-based; they
// are different functions for different screens). So the test is not which
// number it starts at but how far it SPREADS: 300 website links clustered within
// their own pool reach the top of the range, while the same links clustered
// against all 900 would be squeezed into a band near the middle.
const spread = (g: string) => {
  const cs = served.filter((v) => v.genre === g).map((v) => v.rankCluster)
  return { lo: Math.min(...cs), hi: Math.max(...cs) }
}
check('  website links are clustered over their OWN pool', spread('website').lo, 0)
check('  and so are the humanizer ones', spread('humanizer').lo, 0)
// THE DECISIVE ONE. rankPos is the index within the ordering a link came out of,
// so under a single shared ordering exactly ONE link in the whole list could be
// position 0. Every genre having a position 0 is only possible if forPlatform
// ran once per genre - which is the point, because a cluster means nothing
// except relative to the pool it was computed over.
const firstOf = (g: string) =>
  served.filter((v) => v.genre === g).some((v) => v.rankPos === 0)
check('  every genre has a position 0 of its own',
  [firstOf('humanizer'), firstOf('website'), firstOf('slides')], [true, true, true])

console.log('\nan older caller, with no mix, behaves exactly as before:')
const legacy = buildUserFeed(pool, new Set<string>(), 100)
check('  everything from the default genre',
  legacy.served.every((v) => v.genre === DEFAULT_GENRE), true)
check('  and the list is still full', legacy.served.length, 100)

console.log('\na pool with no genre at all reads as the default:')
const old: Row[] = Array.from({ length: 50 }, (_, i) => ({
  url: `https://t/o${i}`, platform: 'tiktok', search_rank: i + 1,
}))
const { served: oldServed } = buildUserFeed(old, new Set<string>(), 20, w)
check('  pre-genre links are still served', oldServed.length, 20)

console.log('\nthe genre list is the one the rest of the code uses:')
check('  three of them, in order', [...GENRES], ['humanizer', 'website', 'slides'])

console.log(`\n${fails === 0 ? 'all correct' : `${fails} FAILED`}`)
process.exit(fails === 0 ? 0 : 1)
