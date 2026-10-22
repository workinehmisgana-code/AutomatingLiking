// Can we actually read the verification video's comments, and do the ids date?
//
//   node scripts/run-ts-check.mjs scripts/probe-verify-video.ts
//
// The whole feature rests on two things being true at once for ONE specific
// video: that TikTok serves its comment list to this server, and that the
// commenters' ids decode to account ages. Both are claims about an undocumented
// endpoint, so they are measured before anything is built on them.
//
// The third thing it measures is the one that decides the design: HOW MANY of
// the video's comments we can actually see. Every worker will comment on this
// same video, so the list only grows - and "their comment is not in what we
// read" is not "they did not comment".
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()
// Defaults to the verification video; takes any URL so a known-busy video can
// be used as a control. "0 comments" from one video means nothing on its own —
// it could be an empty video or TikTok refusing this server, and those have
// very different consequences.
const VIDEO =
  process.argv[2] || 'https://www.tiktok.com/@mypeople334/video/7678712885559692562'

function loadEnv(): void {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

async function main(): Promise<void> {
  loadEnv()
  const { fetchComments } = await import('../lib/linkStats')
  const { accountCreatedAt, accountAge } = await import('../lib/tiktokId')

  console.log(`reading ${VIDEO}\n`)
  const started = Date.now()
  const read = await fetchComments(VIDEO, 6, 20000)
  console.log(`took ${Date.now() - started}ms`)
  console.log(`  unresolved : ${read.unresolved}`)
  console.log(`  total      : ${read.total ?? '(TikTok did not say)'}`)
  console.log(`  read       : ${read.comments.length}`)
  console.log(`  complete   : ${read.complete}`)

  if (read.unresolved) {
    console.log('\nThe link did not resolve to a video. Nothing else can be checked.')
    return
  }
  if (read.comments.length === 0) {
    console.log('\nNo comments came back. Either the video has none, or TikTok refused us.')
    return
  }

  // Do the ids date? A null is not a failure on its own - a pre-snowflake id is
  // an OLD account, which matters later: rejecting nulls would reject exactly
  // the accounts the rule is meant to allow.
  let dated = 0
  let undated = 0
  let young = 0
  const CUTOFF = Date.now() - 90 * 86_400_000
  for (const c of read.comments) {
    const at = accountCreatedAt(c.uid)
    if (!at) { undated++; continue }
    dated++
    if (at.getTime() > CUTOFF) young++
  }
  console.log(`\nof ${read.comments.length} commenters:`)
  console.log(`  ${dated} ids decode to a date`)
  console.log(`  ${undated} do not (pre-snowflake = old accounts, NOT young ones)`)
  console.log(`  ${young} of the dated ones are under 3 months old`)

  console.log('\nthe first eight, as the check would see them:')
  for (const c of read.comments.slice(0, 8)) {
    const at = accountCreatedAt(c.uid)
    const age = at ? accountAge(at) : '(id does not decode)'
    console.log(
      `  @${c.username.padEnd(22)} ${String(at?.toISOString().slice(0, 10) ?? '----------')}  ` +
        `${age.padEnd(22)} ${JSON.stringify(c.text.slice(0, 40))}`
    )
  }

  // WHAT ORDER DOES TIKTOK RETURN THEM IN? This decides whether one shared
  // verification video can work at all. Newest-first means a worker who has
  // just commented is on page one and always findable. Top-first means their
  // comment starts at zero likes somewhere in the middle of thousands, and
  // "not found" would be the normal answer rather than the exceptional one.
  const dates = read.comments
    .map((c) => (c as { postedAt?: string | null }).postedAt)
    .filter((d): d is string => !!d)
  if (dates.length >= 10) {
    const first = dates.slice(0, 10)
    const last = dates.slice(-10)
    const avg = (xs: string[]) =>
      new Date(xs.reduce((n, d) => n + Date.parse(d), 0) / xs.length).toISOString().slice(0, 10)
    console.log(`\nordering, by when the comment was posted:`)
    console.log(`  first ten read, average date: ${avg(first)}`)
    console.log(`  last ten read,  average date: ${avg(last)}`)
    let descending = 0
    for (let i = 1; i < dates.length; i++) {
      if (Date.parse(dates[i]) <= Date.parse(dates[i - 1])) descending++
    }
    const pct = Math.round((descending / (dates.length - 1)) * 100)
    console.log(`  ${pct}% of consecutive pairs are newest-first`)
    console.log(
      pct > 80
        ? '  -> newest first: a fresh comment lands on page one and is findable.'
        : pct < 20
          ? '  -> oldest first: a fresh comment is at the END of thousands.'
          : '  -> NOT chronological (ranked). A fresh comment could be anywhere.'
    )
  }

  // THE SCALING QUESTION. Every worker comments on this one video, so the list
  // grows without limit while the read is capped. If we already cannot see all
  // of it, a worker who commented yesterday may be invisible today.
  if (read.total && read.comments.length < read.total) {
    console.log(
      `\n!! we can see ${read.comments.length} of ${read.total} comments. ` +
        `A worker outside that window cannot be found, and "not found" would ` +
        `read as "did not comment".`
    )
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
