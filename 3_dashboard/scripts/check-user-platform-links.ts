// The Reddit modal on a worker's card must list the clicks the card counts:
// its links' clicks add up to the card's "clicked" figure.
//   node scripts/run-ts-check.mjs scripts/check-user-platform-links.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const db = await import('../lib/db')
  const data = await db.getAdminData(null)
  let bad = 0
  for (const u of data.users) {
    const commented = u.commentedByPlatform.reddit ?? 0
    const clicked = u.clicksByPlatform.reddit ?? 0
    if (!commented && !clicked) continue
    const links = await db.getUserPlatformLinks(u.id, 'reddit')
    const sum = links.reduce((n, l) => n + l.clicks, 0)
    const ok = sum === clicked
    if (!ok) bad++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${(u.profile?.name || u.email).padEnd(24)} reddit: ${commented} commented, ` +
        `${clicked} clicked, modal ${links.length} links / ${sum} clicks`
    )
  }
  console.log(bad ? `${bad} FAILED` : 'all correct')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
