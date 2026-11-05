import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getAdminGenre } from '@/lib/adminGenre'
import { isAdminEmail } from '@/lib/config'
import { genreOfRow } from '@/lib/config'
import { loadVideosJson } from '@/lib/videos'
import { channelOfRow, siteOf } from '@/lib/channelRank'
import { pool as db } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Stat = { active: number; blocked: number }

/** "platform:handle" — a TikTok and an Instagram channel can share a name. */
const keyOf = (platform: string, handle: string) => `${platform}:${handle}`

// GET — per-channel counts of ACTIVE (still in the pool, not blocked) versus
// BLOCKED links, for the channels staged on the Links-to-verify page.
//
// Response: { stats: { "<platform>:<handle>": { active, blocked } },
//             channels, instagramUnattributedBlocked }
//
// ONLY THOSE CHANNELS, AND COUNTED BY THE DATABASE. This used to read the whole
// blocked_link table (262k rows, 39 s from a laptop) plus the 75 MB pool on
// every page open, inside a 60 s limit — and when it ran out of time the page
// showed "—" on every row with no sign anything had failed. Now the blocked
// counts are one grouped query over the staged handles, and the pool is only
// walked for links of those channels.
//
// INSTAGRAM. Its post URLs name nobody, so a blocked Instagram link is charged
// to the owner recorded in blocked_link.account (written at block time, and
// for older blocks by scripts/backfill-blocked-instagram-owners.mjs). Active
// Instagram links are matched by the pool row's author. Blocks whose owner is
// still unknown are counted in `instagramUnattributedBlocked` so the page can
// say the Instagram figures may be flattering until the backfill has run.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    // ONE GENRE: its staged channels, its pool links and the blocks made for
    // it. A channel can be good for one genre and rejected for another.
    const genre = await getAdminGenre()
    const { rows: staged } = await db.query<{ platform: string; account: string }>(
      `SELECT DISTINCT coalesce(platform, 'tiktok') AS platform,
              lower(ltrim(account, '@')) AS account
         FROM verify_link
        WHERE account IS NOT NULL AND account <> ''
          AND coalesce(genre, 'humanizer') = $1`,
      [genre]
    )
    const wanted = new Set(staged.map((r) => keyOf(r.platform, r.account)))
    const stats: Record<string, Stat> = {}
    const igUnknown = await db
      .query<{ n: number }>(
        `SELECT count(*)::int AS n FROM blocked_link
          WHERE genre = $1 AND account IS NULL AND url ~* 'instagram\\.com/'`,
        [genre]
      )
      .then((r) => r.rows[0]?.n ?? 0)
      .catch(() => 0)
    if (wanted.size === 0) {
      return NextResponse.json({ stats, channels: 0, instagramUnattributedBlocked: igUnknown })
    }

    // BLOCKED: every blocked link of these channels, including the ones no
    // longer in the pool — they were removed for a reason, and ignoring them
    // would flatter exactly the channels that have been cleaned up the most.
    // The handle comes from the URL for TikTok/YouTube, from the stored owner
    // for Instagram.
    const handles = Array.from(new Set(staged.map((r) => r.account)))
    const { rows: blockedRows } = await db.query<{ site: string; ch: string; n: number }>(
      `SELECT site, ch, count(*)::int AS n FROM (
         SELECT CASE
                  WHEN url ~* 'instagram\\.com/' THEN 'instagram'
                  WHEN url ~* '(youtube\\.com|youtu\\.be)/' THEN 'youtube'
                  ELSE 'tiktok'
                END AS site,
                lower(coalesce(
                  nullif(ltrim(account, '@'), ''),
                  substring(url from '(?i)tiktok\\.com/@([A-Za-z0-9._]+)'),
                  substring(url from '(?i)youtube\\.com/@([A-Za-z0-9._-]+)'))) AS ch
           FROM blocked_link WHERE genre = $1
       ) b
       WHERE ch = ANY($2::text[])
       GROUP BY site, ch`,
      [genre, handles]
    )
    for (const r of blockedRows) {
      const k = keyOf(r.site, r.ch)
      if (wanted.has(k)) stats[k] = { active: 0, blocked: r.n }
    }

    // ACTIVE: in this genre's pool and not blocked. A blocked URL can still sit
    // in videos.json, so the pool links of these channels are checked against
    // the block list — one query over just those URLs, not the whole table.
    const poolUrls: { url: string; k: string }[] = []
    for (const v of await loadVideosJson().catch(() => [])) {
      if (genreOfRow(v) !== genre) continue
      const url = String((v as { url?: unknown }).url ?? '')
      const ch = channelOfRow(url, (v as { author?: unknown }).author)
      if (!ch) continue
      const k = keyOf(siteOf(url), ch)
      if (wanted.has(k)) poolUrls.push({ url, k })
    }
    const blockedInPool = new Set<string>()
    if (poolUrls.length) {
      const { rows } = await db.query<{ url: string }>(
        `SELECT url FROM blocked_link WHERE genre = $1 AND url = ANY($2::text[])`,
        [genre, poolUrls.map((p) => p.url)]
      )
      for (const r of rows) blockedInPool.add(r.url)
    }
    for (const { url, k } of poolUrls) {
      if (blockedInPool.has(url)) continue
      ;(stats[k] ??= { active: 0, blocked: 0 }).active++
    }

    return NextResponse.json({
      stats,
      channels: Object.keys(stats).length,
      instagramUnattributedBlocked: igUnknown,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
