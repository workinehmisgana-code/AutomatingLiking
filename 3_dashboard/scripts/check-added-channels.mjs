// Can a channel we have never scraped ever be reached?
//
// Before this, no. Every channel the dashboard knows about is worked out from
// links already in the pool, which is a closed loop:
//
//     no links  ->  not in the ranking  ->  the extract pass never visits it
//               ->  no links
//
// So the only channels that could ever be scraped were the ones a keyword search
// had already found. extra_channel is the way in: a handle typed by hand, keyed
// by SITE and handle, merged into the ranking as a real row.
//
// Three things have to be true for that to actually work, and two of them are
// about ORDER rather than about the data:
//
//   1. IT HAS TO BE IN THE RANKING at all, with no links, no hearts and no
//      posting history — because that is what a channel we have never seen is.
//
//   2. IT HAS TO BE VISITED. Extraction walks the ranked list in order, and a
//      channel with none of those signals scores near the bottom of 5,000. Left
//      in score order it would never be reached, which looks exactly like the
//      feature not working.
//
//   3. ITS WHOLE LISTING HAS TO COUNT AS NEW. The extract pass only stages
//      videos posted after the newest one we already hold; a channel with no
//      high-water mark has to be offered everything, or the first extraction
//      returns nothing.
//
// Runs against the real database on a throwaway handle, then removes it.
//
//   node scripts/check-added-channels.mjs
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

// ── what gets read out of what somebody pastes ─────────────────────────────
// Reimplemented from the route: a profile link is what people actually have to
// hand, and it names its own site so nothing has to be chosen.
const RESERVED = /^(p|reel|reels|explore|stories|tv|accounts|direct)$/i
const parse = (raw) => {
  const s = String(raw ?? '').trim()
  if (!s) return { site: null, handle: '' }
  const u = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  const tt = u.match(/^(?:m\.|vm\.)?tiktok\.com\/@([^/?#\s]+)/i)
  if (tt) return { site: 'tiktok', handle: tt[1].toLowerCase() }
  const yt = u.match(/^(?:m\.)?youtube\.com\/@([^/?#\s]+)/i)
  if (yt) return { site: 'youtube', handle: yt[1].toLowerCase() }
  const ig = u.match(/^instagram\.com\/([^/?#\s]+)/i)
  if (ig && !RESERVED.test(ig[1])) return { site: 'instagram', handle: ig[1].toLowerCase() }
  if (/[/.]/.test(s) && !/^@?[A-Za-z0-9._-]+$/.test(s)) return { site: null, handle: '' }
  return { site: null, handle: s.replace(/^@+/, '').toLowerCase() }
}

console.log('what a pasted channel resolves to:')
check('  a tiktok profile link', parse('https://www.tiktok.com/@studyexpert6'),
      { site: 'tiktok', handle: 'studyexpert6' })
check('  with a trailing path', parse('https://www.tiktok.com/@StudyExpert6/video/123'),
      { site: 'tiktok', handle: 'studyexpert6' })
check('  no scheme, no www', parse('tiktok.com/@studyexpert6'),
      { site: 'tiktok', handle: 'studyexpert6' })
check('  an instagram profile', parse('https://www.instagram.com/betweenstudybreaks/'),
      { site: 'instagram', handle: 'betweenstudybreaks' })
check('  a youtube handle url', parse('https://www.youtube.com/@SomeChannel'),
      { site: 'youtube', handle: 'somechannel' })
// instagram.com/<handle>/ and instagram.com/p/<code>/ have the same shape, so a
// pasted POST link would otherwise register a channel called "p".
check('  an instagram POST is not a channel', parse('https://www.instagram.com/p/DcSgO_HpdUm/'),
      { site: null, handle: '' })
check('  nor is a reel', parse('https://www.instagram.com/reel/ABC/'), { site: null, handle: '' })
// A bare handle names no site, and the same handle exists on more than one.
check('  a bare handle names no site', parse('@studyexpert6'),
      { site: null, handle: 'studyexpert6' })
check('  something that is neither is refused', parse('not a channel/at all!'),
      { site: null, handle: '' })
const route = read('app/api/admin/verify-links/channels/route.ts')
// The parser lives in lib/, not in the route: a Next route module may only
// export its HTTP handlers, so a pure function exported beside them fails the
// build outright.
const parser = read('lib/channelInput.ts')
check('  the parser is not exported from the route', /export function parseChannelInput/.test(route), false)
check('  it lives where it can be tested', /export function parseChannelInput/.test(parser), true)
check('  and the route makes the caller choose one',
      /Which site is this channel on\?/.test(route), true)
check('  saying why guessing is not allowed', /would send the scraper to/.test(route), true)

// ── the live database ──────────────────────────────────────────────────────
const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
const q = async (sql, p = []) => (await db.query(sql, p)).rows

const H = '__addedcheck__'
try {
  await db.query('DELETE FROM extra_channel WHERE handle = $1', [H])

  console.log('\nthe table is there and keyed the way the ranking is:')
  const pk = await q(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'extra_channel'::regclass AND i.indisprimary
      ORDER BY a.attname`
  )
  check('  site AND handle', pk.map((r) => r.attname), ['handle', 'site'])

  await db.query('INSERT INTO extra_channel (site, handle, note) VALUES ($1, $2, $3)',
                 ['tiktok', H, 'a check'])
  const dup = await db.query(
    `INSERT INTO extra_channel (site, handle, note) VALUES ($1, $2, $3)
     ON CONFLICT (site, handle) DO NOTHING`, ['tiktok', H, 'again'])
  check('  adding the same one twice changes nothing', dup.rowCount, 0)
  check('  and keeps the first note',
        (await q('SELECT note FROM extra_channel WHERE handle = $1', [H]))[0].note, 'a check')
  // The same handle on another site is a DIFFERENT channel. 98 of our handles
  // exist on more than one, and adding @x on Instagram must not mean @x on
  // TikTok.
  await db.query('INSERT INTO extra_channel (site, handle) VALUES ($1, $2)', ['instagram', H])
  check('  the same handle on another site is its own row',
        (await q('SELECT COUNT(*)::int n FROM extra_channel WHERE handle = $1', [H]))[0].n, 2)
} finally {
  await db.query('DELETE FROM extra_channel WHERE handle = $1', [H])
  await db.end()
}

// ── the ranking ────────────────────────────────────────────────────────────
const rank = read('lib/channelRank.ts')
const ui = read('components/VerifyLinks.tsx')
console.log('\nan added channel is a real row in the ranking:')
check('  the extras are loaded with the pool', /getExtraChannels\(\)\.catch\(\(\) => \[\]\)/.test(rank), true)
check('  merged after it, so a channel WITH links keeps its numbers',
      /const a =\s*\n?\s*acc\.get\(key\) \?\? \{ handle, site, links: 0, active: 0, hearts: \[\], times: \[\], added: false \}/.test(rank),
      true)
check('  and marked either way', /a\.added = true/.test(rank), true)
check('  keyed by site and handle, like every other channel',
      /const key = channelKey\(site, handle\)/.test(rank), true)

console.log('\nand it is actually VISITED, which is the part that could silently fail:')
// A channel with no links scores near the bottom of 5,000 by construction, and
// extraction walks this list in order. Left in score order it would never be
// reached — and that looks exactly like the feature not working.
check('  a channel with no links of its own sorts first',
      /const isNew = \(r: ChannelRow\) => r\.added && r\.links === 0/.test(rank), true)
check('  ahead of the score', /Number\(isNew\(b\)\) - Number\(isNew\(a\)\) \|\|\s*\n?\s*b\.score - a\.score/.test(rank), true)
// Self-limiting: once it has links it ranks on them, so nothing is pinned to
// the top for ever.
check('  but only until it has links, so nothing is pinned',
      /Self-limiting/.test(rank), true)
check('  and the row says why it is there', /added/.test(read('components/VerifyLinks.tsx')), true)

console.log('\nthe hourly harvest visits it too:')
const harvest = read('lib/channelHarvest.ts')
// The harvest normally skips a channel with no active/blocked ratio. An added
// channel has no ratio for the same reason it has no anything.
check('  the 50%-active rule has an exception for it',
      /\(c\.added && c\.links === 0\) \|\| \(c\.activePct !== null/.test(harvest), true)
check('  and it says why', /A person typing a handle in is a\s*\n?\s*\/\/ better reason/.test(harvest), true)

console.log('\nits first extraction offers the whole listing:')
// The extract pass only stages what was posted after the newest video it
// already holds. A channel with no mark has to be offered everything, or its
// first extraction returns nothing at all.
const extract = read('app/api/admin/verify-links/extract/route.ts')
check('  no high-water mark means no filter',
      /const since = newestByHandle\.get\(handle\.toLowerCase\(\)\) \?\? null/.test(extract), true)
check('  and everything is new', /if \(since === null\) return true/.test(extract), true)
check('  which the route already said out loud',
      /A channel we have never touched has no mark, so its whole listing\s*\n\s*\/\/ is offered/.test(extract),
      true)
// The client sends the handles on screen; an added channel must survive that
// lookup or it would be dropped before anything was fetched.
check('  and a filtered run still finds it',
      /const known = new Map\(\s*\n?\s*ranked\.filter\(\(c\) => c\.platform === 'tiktok'\)/.test(extract), true)

console.log('\nadding one leaves Extract usable, which it did not at first:')
// The bug: the button is disabled until the channels have been ranked, because
// it walks that list in that order. Adding a channel without ranking first left
// it dead next to a message saying "press Extract to stage them".
// Scoped to addChannel: removeChannel keeps its conditional on purpose, because
// forgetting a channel is no reason to make a ranking appear that was not there.
const addFn = ui.split('async function addChannel()')[1].split('async function removeChannel')[0]
check('  ranking happens on every add, not only when a list is already up',
      /const list = await rankChannels\(\)/.test(addFn) && !/if \(ranked\)/.test(addFn), true)
// setRanked schedules a render, so the caller cannot read `ranked` on the next
// line. The list has to come back from the call.
check('  and the list comes back from the call, not from state',
      /async function rankChannels\(\): Promise<ChannelRank\[\] \| null>/.test(ui), true)
// The second way the same thing fails: extraction runs over exactly the rows the
// FILTERS leave on screen, and a channel we hold no links from can never pass a
// minimum-links filter.
check('  one definition of "survives the filters", shared with the table',
      /const passesChannelFilters = \(c: ChannelRank\): boolean =>/.test(ui), true)
check('  the table uses it', /\.filter\(passesChannelFilters\)/.test(ui), true)
check('  and the add form checks the new channel against it',
      /!passesChannelFilters\(row\)/.test(ui), true)
check('  saying so rather than leaving a dead button to explain itself',
      /filters are hiding @\{addHidden\.handle\}/.test(ui), true)
check('  with a way through', /Clear the filters and show it/.test(ui), true)
// The site chip is not part of clearChannelFilters, so clearing has to reset it
// too or a TikTok channel stays hidden behind an Instagram chip.
check('  that also clears the site chip',
      /clearChannelFilters\(\)\s*\n\s*setRankSite\(''\)/.test(ui), true)
// A channel saved but missing from the ranking is a different fault, and says
// so rather than blaming the filters.
check('  a channel missing from the ranking is reported as that',
      /was saved but is not in the ranked list/.test(ui), true)

console.log('\nand it can be extracted from ON ITS OWN, without walking the other 4,000:')
// Extraction already runs over exactly the rows the filters leave on screen, so
// "the added ones only" is one more filter rather than a second mechanism
// beside the first.
check('  there is a filter for hand-added channels', /const \[onlyAdded, setOnlyAdded\] = useState\(false\)/.test(ui), true)
check('  and it is part of the one shared predicate',
      /passesChannelFilters = \(c: ChannelRank\): boolean =>\s*\n\s*\(!onlyAdded \|\| c\.added\)/.test(ui), true)
check('  with a chip to turn it on', /Added by hand \(\{addedCount\}\)/.test(ui), true)
check('  that Clear filters turns off again', /setOnlyAdded\(false\)/.test(ui), true)

// And a one-press path, because the whole point of adding a channel is to go
// and get its videos.
check('  a button extracts from the added ones alone', /async function extractAdded\(\)/.test(ui), true)
check('  it narrows the table to the same set', /setOnlyAdded\(true\)/.test(ui), true)
// Anything left over from an earlier session would silently shrink the run.
const added = ui.split('async function extractAdded()')[1].split('async function removeChannel')[0]
check('  clearing every other filter first', /setRankSite\(''\)/.test(added) && /setFLinks\(\['', ''\]\)/.test(added), true)
// The set comes from the RETURNED list, not from `ranked`: this is pressed
// seconds after an add, and setRanked only schedules a render.
check('  and works from the list the ranking returned',
      /const list = \(await rankChannels\(\)\) \?\? ranked/.test(added), true)
check('  passing it to extractNew explicitly', /await extractNew\(mine\.filter/.test(added), true)
check('  which accepts an explicit subset', /async function extractNew\(subset\?: ChannelRank\[\]\)/.test(ui), true)
check('  and still defaults to what is on screen', /const pick = subset \?\? extractable/.test(ui), true)
// Nothing to extract from is a sentence, not a button that does nothing.
check('  nothing added is said out loud', /No channels have been added by hand/.test(ui), true)

console.log('\nan extraction that does nothing says so:')
// A button press that produces no output at all is indistinguishable from a
// broken button - and this is the one path where the selection can legitimately
// be empty, so it was the one that could go quiet.
check('  an empty selection is explained, not returned from silently',
      /Nothing to check: no TikTok channel is in this selection/.test(ui), true)
check('  including when the selection is all Instagram or YouTube',
      /channel\(s\) in this selection are/.test(ui), true)
// Over four thousand channels a count is all anybody can use; over the handful
// somebody just added, the handle is the whole answer.
check('  the route names the channels that answered with nothing',
      /failedHandles\.push\(handle\)/.test(extract), true)
check('  and sends them back', /failedHandles,/.test(extract), true)
check('  capped, because it is a diagnostic not a second copy of the request',
      /failedHandles\.length < 40/.test(extract), true)
check('  the page names them', /channel\(s\) answered with no videos/.test(ui), true)
check('  and says what the three causes are',
      /the handle is wrong, the account is gone or private, or TikTok is/.test(ui), true)

console.log('\nwhat the admin is told:')
check('  a typo is caught where it can be', /fetchChannelVideos\(parsed\.handle\)/.test(route), true)
check('  but never blocks the add', /A miss does NOT block the add/.test(route), true)
check('  "already there" is not reported as "added"', /was already on the list/.test(ui), true)
check('  nor is "added but nothing listed"', /TikTok listed nothing for it/.test(ui), true)
// Instagram and YouTube can be added, but this server cannot list their posts.
// Saying so is the difference between a limitation and a bug report.
check('  a site we cannot list says so', /cannot be listed from here/.test(ui), true)
check('  and points at the thing that can', /Export handles/.test(ui), true)
// Removing the request must not look like removing the work.
check('  removing one keeps the links it already produced',
      /not .throw away the work./.test(read('lib/db.ts')), true)

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
