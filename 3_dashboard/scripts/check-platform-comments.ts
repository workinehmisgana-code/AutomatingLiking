// YouTube and Reddit comment checks, against canned API answers (no network).
//   node scripts/run-ts-check.mjs scripts/check-platform-comments.ts
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
// Fake keys so both platforms count as switched on; every request is stubbed below.
process.env.YOUTUBE_API_KEY = 'test-key'
process.env.REDDIT_CLIENT_ID = 'id'
process.env.REDDIT_CLIENT_SECRET = 'secret'

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const yt = (author: string, text: string, at: string, channel = 'UCx') => ({
  snippet: {
    topLevelComment: {
      snippet: { authorDisplayName: '@' + author, authorChannelId: { value: channel }, textOriginal: text, publishedAt: at },
    },
  },
})
const rd = (author: string, body: string, secs: number, replies: unknown = '') => ({
  kind: 't1',
  data: { author, body, created_utc: secs, replies },
})

let pages: Record<string, unknown> = {}
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const u = String(input)
  if (u.includes('access_token')) return json({ access_token: 'tok', expires_in: 3600 })
  for (const k of Object.keys(pages)) if (u.includes(k)) {
    const v = pages[k]
    return typeof v === 'number' ? json({}, v) : json(v)
  }
  return json({}, 404)
}) as typeof fetch

async function main(): Promise<void> {
  const P = await import('../lib/platformComments')
  const { judgeLinks } = await import('../lib/commentPresence')
  let bad = 0
  const ok = (c: boolean, w: string) => { console.log((c ? 'ok     ' : 'FAILED ') + w); if (!c) bad++ }

  ok(P.youtubeVideoId('https://www.youtube.com/shorts/_WdtfYQmA_A') === '_WdtfYQmA_A', 'shorts id')
  ok(P.youtubeVideoId('https://youtu.be/Nhaqr3Syn44?si=x') === 'Nhaqr3Syn44', 'youtu.be id')
  ok(P.youtubeVideoId('https://www.youtube.com/watch?v=z8sdKv4L31c&t=3') === 'z8sdKv4L31c', 'watch id')
  ok(P.redditPostId('https://www.reddit.com/r/humanizing/comments/1r3x0as/which/') === '1r3x0as', 'reddit id')
  ok(P.youtubeIdentity('https://youtube.com/@honeydere?feature=shared').handle === 'honeydere', 'profile handle')
  ok(P.platformOfUrl('https://www.youtube.com/shorts/abc') === 'youtube' && P.platformOfUrl('https://instagram.com/p/x') === null, 'platform of url')
  ok(/youtube/.test(P.verifiableUrlSql()) && /reddit/.test(P.verifiableUrlSql()), 'window includes YouTube and Reddit when keys are set')

  ok(P.matchesServed('i use "Purify Text" now and it passes every time 🙌', 'i use purifytext now and it passes every time'), 'served comment recognised through quotes, split brand, emoji')
  ok(!P.matchesServed('this is so good', 'this is so good'), 'too short to tell strangers apart')
  ok(!P.matchesServed('purifytext never worked for me honestly, total waste', 'i use purifytext now and it passes every time'), 'different sentence not matched')

  // ── YouTube: newest first, stop once older than the click ──
  const click = '2026-11-20T12:00:00Z'
  pages = {
    'videoId=AAAAAAAAAAA': {
      items: [
        yt('someone', 'nice', '2026-11-22T10:00:00Z'),
        yt('honeydere', 'i use purifytext now and it passes every time', '2026-11-21T10:00:00Z'),
        yt('old', 'old one', '2026-11-01T10:00:00Z'),
      ],
      nextPageToken: 'more',
    },
    'videoId=BBBBBBBBBBB': { items: [yt('someone', 'nice', '2026-11-22T10:00:00Z'), yt('old', 'x', '2026-11-01T00:00:00Z')] },
    'videoId=CCCCCCCCCCC': 403,
    'videoId=DDDDDDDDDDD': { items: [yt('someone', 'nice', '2026-11-22T10:00:00Z')], nextPageToken: 'more' },
  }
  const r1 = await P.fetchYoutubeComments('https://www.youtube.com/shorts/AAAAAAAAAAA', click)
  ok(r1.complete && r1.comments.length === 3, 'YouTube read stops at a comment older than the click and calls it complete')
  const r3 = await P.fetchYoutubeComments('https://www.youtube.com/shorts/CCCCCCCCCCC', click)
  ok(r3.unresolved, 'comments switched off -> unresolved, not a miss')

  const who = { userId: '', tiktok: null, ytHandle: 'honeydere', ytChannel: null, known: {} }
  // judgeLinks answers in the order reads finish, so look each one up by url.
  const byId = (rs: { url: string }[]) => (id: string) => rs.find((r) => r.url.includes(id))!
  const ys = byId(await judgeLinks(who, [
    'https://www.youtube.com/shorts/AAAAAAAAAAA',
    'https://www.youtube.com/shorts/BBBBBBBBBBB',
    'https://www.youtube.com/shorts/CCCCCCCCCCC',
    'https://www.youtube.com/shorts/DDDDDDDDDDD',
  ], Date.now() + 30000)) as (id: string) => Awaited<ReturnType<typeof judgeLinks>>[number]
  const [a, b, c, d] = ['AAAA', 'BBBB', 'CCCC', 'DDDD'].map(ys)
  ok(a.found && a.judgeable && /purifytext/.test(a.text ?? ''), 'YouTube: their channel\'s comment found')
  ok(!b.found && b.judgeable, 'YouTube: complete read without them is a judged miss')
  ok(!c.found && !c.judgeable, 'YouTube: unreadable video is not judged')
  // D has no click time (no hint) and pages forever -> stops at the page cap, incomplete.
  ok(!d.found && !d.judgeable, 'YouTube: read cut off by the page cap is not judged')
  const nobody = await judgeLinks({ userId: '', tiktok: null, ytHandle: null, ytChannel: null, known: {} },
    ['https://www.youtube.com/shorts/BBBBBBBBBBB'], Date.now() + 30000)
  ok(!nobody[0].judgeable, 'no account and no handed-out comment -> absence proves nothing')

  // ── Reddit ──
  const post = (n: number) => ({ data: { children: [{ kind: 't3', data: { num_comments: n } }] } })
  pages = {
    'comments/aaa111': [post(3), { data: { children: [
      rd('stranger', 'hm', 1763800000, { data: { children: [rd('throwaway_hd', 'honestly i use purifytext now and it passes every time', 1763800100)] } }),
      rd('other', 'ok', 1763700000),
    ] } }],
    'comments/bbb222': [post(40), { data: { children: [rd('x', 'y', 1763800000), { kind: 'more', data: { count: 30, children: ['a', 'b'] } }] } }],
    'comments/ccc333': [post(2), { data: { children: [rd('x', 'y', 1763800000), rd('z', 'w', 1763800000)] } }],
  }
  const rr = await P.fetchRedditComments('https://www.reddit.com/r/x/comments/aaa111/t/')
  ok(rr.complete && rr.comments.length === 3 && rr.total === 3, 'Reddit: nested replies read, complete')
  const rm = await P.fetchRedditComments('https://www.reddit.com/r/x/comments/bbb222/t/')
  ok(!rm.complete, 'Reddit: "load more comments" left -> incomplete')
  const rwho = { userId: '', tiktok: null, ytHandle: null, ytChannel: null, known: { reddit: 'throwaway_hd' } }
  const rs = byId(await judgeLinks(rwho, [
    'https://www.reddit.com/r/x/comments/aaa111/t/',
    'https://www.reddit.com/r/x/comments/bbb222/t/',
    'https://www.reddit.com/r/x/comments/ccc333/t/',
  ], Date.now() + 30000)) as (id: string) => Awaited<ReturnType<typeof judgeLinks>>[number]
  const [ra, rb, rc] = ['aaa111', 'bbb222', 'ccc333'].map(rs)
  ok(ra.found && ra.judgeable, 'Reddit: their (learned) account\'s reply found')
  ok(!rb.found && !rb.judgeable, 'Reddit: hidden comments left -> not judged')
  ok(!rc.found && rc.judgeable, 'Reddit: complete thread without them -> judged miss')

  // ── the SQL still runs ──
  globalThis.fetch = realFetch
  const db = await import('../lib/db')
  const { rows } = await db.pool.query<{ user_id: string }>(
    "SELECT user_id FROM user_profile WHERE name ILIKE 'Honey D%' LIMIT 1")
  if (rows[0]) {
    const recent = await db.getRecentClickedLinks(rows[0].user_id, 300)
    const n = (re: RegExp) => recent.filter((x) => re.test(x.url)).length
    console.log(`  sample user's window now: ${recent.length} links — tiktok ${n(/tiktok/)}, youtube ${n(/youtu/)}, reddit ${n(/reddit/)}`)
    ok(n(/youtu/) > 0, 'a YouTube worker\'s window now holds their YouTube links')
    const hints = await db.getClickHints(rows[0].user_id, recent.slice(0, 20).map((x) => x.url))
    const served = Array.from(hints.values()).filter((h) => h.servedComment).length
    console.log(`  handed-out comment stored on ${served} of ${hints.size} of those clicks`)
    await db.handlesOwnedByOthers(rows[0].user_id, 'youtube', ['honeydere', 'nobody_here_x'])
    await db.getRecentJudgedRate(rows[0].user_id, 200)
    await db.getRecentJudgedByProduct(rows[0].user_id)
    ok(true, 'ledger queries run')
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall correct')
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
