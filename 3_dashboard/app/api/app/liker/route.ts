import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import {
  buildAdminLinks,
  filterAdminLinks,
  sortAdminLinks,
  type LinkQuery,
} from '@/lib/adminLinks'
import { getActiveCommentProducts, getUrlsWithProductComments } from '@/lib/db'
import { getLikerSettings } from '@/lib/likerSettings'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// What the phone needs to start working: the settings an admin chose, and the
// links they point at.
//
// WHY THE PHONE DOES NOT WORK THIS OUT ITSELF. Clusters are RELATIVE — assigned
// by splitting the sorted pool per platform — so they exist nowhere in the
// database and anything recomputing them drifts from what the admin sees on
// screen. This calls buildAdminLinks + filterAdminLinks, the same path the
// admin Links page uses, which is the only way the two can agree.
//
// Authenticated as the app user, not with the export token: this is the phone
// in somebody's hand, and the token in it is theirs.
//
//   GET /api/app/liker        → { settings, links, products }
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const s = await getLikerSettings()
  // Switched off is an answer, not an error: the app shows it and stops asking.
  if (!s.enabled) {
    return NextResponse.json({ ok: true, enabled: false, settings: s, links: [], products: [] })
  }

  const clusters = String(s.clusters || '')
    .split(',')
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)

  const qy: LinkQuery = {
    platform: s.platform,
    // Blank means every genre, which is what it did before genres existed.
    genre: s.genre,
    category: s.category,
    clusters,
    clusterBy: s.clusterBy,
    sortDir: 'desc',
  }

  try {
    const built = await buildAdminLinks('')
    let matched = sortAdminLinks(filterAdminLinks(built.rows, qy, built.retirePlatforms), qy)

    // Links known to carry NONE of our comments are no use to a liker: it has
    // nothing of ours to heart there. Dropped before the list is sent, so the
    // phone does not spend a page load each to find that out.
    const withOurs = new Set(await getUrlsWithProductComments().catch(() => [] as string[]))
    const before = matched.length
    matched = matched.filter((l) => withOurs.has(l.url))
    const droppedWithoutOurs = before - matched.length

    const links = matched.slice(0, s.maxLinks).map((l) => ({
      url: l.url,
      // THE VIDEO'S OWN LIKE COUNT travels with the link, because both the
      // ceiling and the floor are fractions of it and the phone cannot work
      // either out without the number. It is already loaded here.
      likes: l.like_count,
      // Which cluster this came from, under the ordering that was asked for.
      cluster:
        s.clusterBy === 'rank'
          ? l.rankCluster
          : s.clusterBy === 'date'
            ? l.dateCluster
            : l.combinedCluster,
    }))

    // The products the admin has switched on, so the phone matches comments
    // against the set being served rather than a list hardcoded in the app.
    const active = await getActiveCommentProducts().catch(() => [] as string[])
    const products = s.keywords
      ? s.keywords.split(',').map((k) => k.trim()).filter(Boolean)
      : active

    return NextResponse.json({
      ok: true,
      enabled: true,
      settings: s,
      products,
      matched: matched.length,
      droppedWithoutOurs,
      links,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
