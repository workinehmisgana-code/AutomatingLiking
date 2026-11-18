// Search links held back by the upload's title check: staged in verify_link
// with their keyword and rank, and merged into the SEARCH clusters (not
// date-only). A channel link still merges date-only. Cleans up after itself.
//   node scripts/run-ts-check.mjs scripts/check-search-verify.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const { saveVerifyLinks, getVerifyLinksByUrls, deleteVerifyLinks } = await import('../lib/db')
  const { verifyRowToVideo } = await import('../lib/verifyMerge')
  let bad = 0
  const ok = (c: boolean, what: string) => {
    console.log(`  ${c ? 'ok    ' : 'FAILED'} ${what}`)
    if (!c) bad++
  }
  const S = 'https://www.tiktok.com/@zz_check_search/video/7000000000000000001'
  const C = 'https://www.tiktok.com/@zz_check_search/video/7000000000000000002'
  try {
    await saveVerifyLinks([
      { url: S, account: 'zz_check_search', view_count: 5400, heart_count: 0, title: 'pasta night',
        genre: 'humanizer', search_query: 'ai humanizer', search_rank: 17 },
      { url: C, account: 'zz_check_search', view_count: 900, heart_count: 120, title: 'channel video', genre: 'humanizer' },
    ])
    // A channel re-stage of the search link must not wipe its keyword/rank.
    await saveVerifyLinks([{ url: S, account: 'zz_check_search', title: 'pasta night', genre: 'humanizer' }])
    const rows = await getVerifyLinksByUrls([S, C])
    const s = rows.find((r) => r.url === S)!
    const c = rows.find((r) => r.url === C)!
    ok(s.search_query === 'ai humanizer' && s.search_rank === 17, 'staged search link keeps its keyword and rank')
    ok(c.search_rank === 0, 'a channel link has no rank')
    const now = new Date().toISOString()
    const vs = verifyRowToVideo(s, now)
    const vc = verifyRowToVideo(c, now)
    ok(vs.search_rank === 17 && vs.search_query === 'ai humanizer' && !vs.date_only, 'merged search link → search clusters')
    ok(vs.like_count === 5400, 'merged search link keeps the search grid count')
    ok(vc.search_rank === 0 && vc.date_only === true, 'merged channel link → date clusters, as before')
  } finally {
    await deleteVerifyLinks([S, C])
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
