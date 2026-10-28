import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getAdminGenre } from '@/lib/adminGenre'
import { isAdminEmail } from '@/lib/config'
import { genreOfRow } from '@/lib/config'
import { loadVideosJson } from '@/lib/videos'
import { pool as db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * The channel a TikTok or YouTube link belongs to, from the URL itself.
 *
 * Instagram is deliberately absent: a post URL (instagram.com/p/<id>/) names no
 * channel, and blocking a link removes it from the pool — so a blocked
 * Instagram link can never be traced back to whoever posted it. Its channel's
 * blocked count is unknowable, and a percentage built on a blocked count of
 * zero would read "100% active" for every Instagram channel. Leaving it out is
 * the same rule lib/channelRank.ts applies to the channel list.
 */
function channelOf(url: string): string | null {
  const u = String(url || '')
  const tt = u.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
  if (tt) return tt[1].toLowerCase()
  const yt = u.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return yt[1].toLowerCase()
  return null
}

// GET — per-channel counts of ACTIVE (still in the pool, not blocked) versus
// BLOCKED links, for the channels staged on the Links-to-verify page.
//
// ONLY THOSE CHANNELS, AND COUNTED BY THE DATABASE. This used to read the whole
// blocked_link table (262k rows, 39 s from a laptop) plus the 75 MB pool on
// every page open, inside a 60 s limit — and when it ran out of time the page
// showed "—" on every row with no sign anything had failed. Now the blocked
// counts are one grouped query over the staged handles, and the pool is only
// walked for links of those channels.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    // ONE GENRE: its staged channels, its pool links and the blocks made for
    // it. A channel can be good for one genre and rejected for another.
    const genre = await getAdminGenre()
    const { rows: staged } = await db.query<{ account: string }>(
      `SELECT DISTINCT lower(account) AS account FROM verify_link
        WHERE account IS NOT NULL AND account <> '' AND platform <> 'instagram'
          AND coalesce(genre, 'humanizer') = $1`,
      [genre]
    )
    const wanted = new Set(staged.map((r) => r.account))
    const stats: Record<string, { active: number; blocked: number }> = {}
    if (wanted.size === 0) return NextResponse.json({ stats, channels: 0 })

    // BLOCKED: every blocked link of these channels, including the ones no
    // longer in the pool — they were removed for a reason, and ignoring them
    // would flatter exactly the channels that have been cleaned up the most.
    const handles = Array.from(wanted)
    const { rows: blockedRows } = await db.query<{ ch: string; n: number }>(
      `SELECT ch, count(*)::int AS n FROM (
         SELECT lower(coalesce(
                  substring(url from '(?i)tiktok\\.com/@([A-Za-z0-9._]+)'),
                  substring(url from '(?i)youtube\\.com/@([A-Za-z0-9._-]+)'))) AS ch
           FROM blocked_link WHERE genre = $1
       ) b
       WHERE ch = ANY($2::text[])
       GROUP BY ch`,
      [genre, handles]
    )
    for (const r of blockedRows) stats[r.ch] = { active: 0, blocked: r.n }

    // ACTIVE: in this genre's pool and not blocked. A blocked URL can still sit
    // in videos.json, so the pool links of these channels are checked against
    // the block list — one query over just those URLs, not the whole table.
    const poolUrls: { url: string; ch: string }[] = []
    for (const v of await loadVideosJson().catch(() => [])) {
      if (genreOfRow(v) !== genre) continue
      const url = String((v as { url?: unknown }).url ?? '')
      const ch = channelOf(url)
      if (ch && wanted.has(ch)) poolUrls.push({ url, ch })
    }
    const blockedInPool = new Set<string>()
    if (poolUrls.length) {
      const { rows } = await db.query<{ url: string }>(
        `SELECT url FROM blocked_link WHERE genre = $1 AND url = ANY($2::text[])`,
        [genre, poolUrls.map((p) => p.url)]
      )
      for (const r of rows) blockedInPool.add(r.url)
    }
    for (const { url, ch } of poolUrls) {
      if (blockedInPool.has(url)) continue
      ;(stats[ch] ??= { active: 0, blocked: 0 }).active++
    }

    return NextResponse.json({ stats, channels: Object.keys(stats).length })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
