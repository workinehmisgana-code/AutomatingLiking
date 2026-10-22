// Titles that cannot belong to the links they are stored against.
//
// A caption belongs to one video. When the SAME caption is stored against links
// from many DIFFERENT accounts, at least all but one of them is wrong — people
// do reuse a caption across their own posts, but eighty strangers do not write
// the same sentence.
//
// Two were checked by hand against TikTok's oEmbed, which answers for one item
// id and cannot confuse two videos:
//
//   @ethio_computer_school/photo/7622551066676120853
//     stored: "By using <humanizer.help> #essaywriting #aihumanizer …"
//     real  : "🚀 YouTube Payment Workflow for Ethiopian Creators ዩትዩብ …"
//   @bethel_njoku01/…
//     stored: the same humanizer caption
//     real  : "💥 Jack just laid off 4,000 employees in one day!!! …"
//
// Neither came from the pool file (it carries no titles at all) nor from the
// verify list (no row holds that text). What is left is a title fetch that
// answered with something other than the video asked for.
//
//   node scripts/check-shared-titles.mjs            report
//   node scripts/check-shared-titles.mjs --apply    forget them, so they refetch
//   node scripts/check-shared-titles.mjs --min 10   only titles spanning 10+ accounts
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const MIN = Number(args[args.indexOf('--min') + 1]) || 6

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

// The account is in the URL for TikTok and YouTube; Instagram /p/ links name
// nobody, so they are counted as one unknown account and cannot trip the test on
// their own.
const SHARED = `
  SELECT title,
         count(*)::int AS links,
         count(DISTINCT substring(url from '@([A-Za-z0-9._]+)'))::int AS accounts
  FROM link_title
  GROUP BY title
  HAVING count(DISTINCT substring(url from '@([A-Za-z0-9._]+)')) >= $1
  ORDER BY accounts DESC`

try {
  const { rows } = await db.query(SHARED, [MIN])
  const links = rows.reduce((n, r) => n + r.links, 0)
  const total = Number((await db.query('SELECT count(*)::int n FROM link_title')).rows[0].n)

  console.log(`${total.toLocaleString()} stored titles.`)
  console.log(
    `${rows.length.toLocaleString()} of them are stored against links from ${MIN}+ ` +
      `different accounts, covering ${links.toLocaleString()} link(s) ` +
      `(${((links / total) * 100).toFixed(1)}% of the table).\n`
  )
  console.log('the worst of them:')
  for (const r of rows.slice(0, 12)) {
    console.log(
      `  ${String(r.accounts).padStart(4)} accounts  ${String(r.links).padStart(4)} links  ` +
        JSON.stringify(r.title.slice(0, 62))
    )
  }

  if (!APPLY) {
    console.log(
      `\nNothing was changed. --apply forgets these ${links.toLocaleString()} title(s) so the ` +
        'Links page refetches them from oEmbed, which is the source that can be trusted ' +
        'per video.'
    )
  } else {
    const { rowCount } = await db.query(
      `DELETE FROM link_title WHERE title IN (
         SELECT title FROM link_title
         GROUP BY title
         HAVING count(DISTINCT substring(url from '@([A-Za-z0-9._]+)')) >= $1)`,
      [MIN]
    )
    console.log(`\nforgot ${rowCount?.toLocaleString()} title(s).`)
    console.log('Select those links on the Links page and press Process to refetch them.')
  }
} finally {
  await db.end()
}
