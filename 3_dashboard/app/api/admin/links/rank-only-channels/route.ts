import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { buildAdminLinks, type AdminLinkRow } from '@/lib/adminLinks'
import { channelOf } from '@/lib/dateScore'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Which CHANNELS are on the search-rank side but not on the posted-date side.
//
// The comparison is between channels, not links, and it is over the whole pool —
// a cluster selection only narrows it further if one is given.
//
// WHAT "ON A SIDE" MEANS, since the obvious reading has no answer:
//
//   rank side  the channel has at least one link with a search rank (and not
//              flagged date_only, which is excluded from rank clustering).
//   date side  the channel has at least one link carrying a DATE SCORE — the
//              number the posted-date clusters are actually built from.
//
// The date side is defined by the score rather than by "has a date cluster",
// because every link is given a date cluster whether or not it has a score:
// unscored links sort to the bottom and land in the last bucket only because
// everything must land somewhere. Counting those as present would make every
// ranked channel present too, and the answer would always be zero. Measured on
// the live pool: 1,126 of 128,496 links carry no score, and once they are
// excluded 829 channels are on the rank side alone.
//
// What those channels ARE: people find them through a keyword, but nothing they
// have posted is scored — usually because their links are blocked, or were added
// after the last recluster. They rank, and we are not ranking them.
//
//   GET ?clusters=1,2,3&platform=tiktok   (both optional)

// channelOf returns "platform:handle" so two people with the same name on two
// sites stay apart. That compound is a KEY, not something to show — split here
// rather than in the page, so the profile link is built where the platform is
// already known for certain.
const PROFILE_URL: Record<string, (h: string) => string> = {
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  youtube: (h) => `https://www.youtube.com/@${h}`,
  instagram: (h) => `https://www.instagram.com/${h}/`,
}

function splitChannel(key: string): { platform: string; handle: string; profileUrl: string } {
  const i = key.indexOf(':')
  const platform = i > 0 ? key.slice(0, i) : ''
  const handle = i > 0 ? key.slice(i + 1) : key
  return { platform, handle, profileUrl: PROFILE_URL[platform]?.(handle) ?? '' }
}

interface ChannelRow {
  /** "platform:handle" — the key the sets are built on. */
  channel: string
  platform: string
  handle: string
  /** Where the channel lives, so the name can be opened directly. */
  profileUrl: string
  links: number
  bestCluster: number
  bestRank: number
  sample: string
  /** The search keywords that turned this channel up, best-ranked first. A
   *  channel can rank for several, and which one found it is what decides
   *  whether it is worth re-scraping. */
  keywords: string[]
  /** The channel's rank-side links, best rank first. Each carries the cached
   *  title, because judging a link is reading its title — and the keyword and
   *  cluster it earned, so a flat list of these needs nothing from the parent.
   *  Capped: one channel with four hundred links must not make the response
   *  unusable. */
  videos: {
    url: string
    title: string
    rank: number
    cluster: number
    keyword: string
    blocked: boolean
  }[]
}

/** Links listed per channel before the row just says "and N more". */
const MAX_VIDEOS_PER_CHANNEL = 50

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const clusters = (sp.get('clusters') ?? '')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  const platform = String(sp.get('platform') ?? '').trim()
  // Blocked links are left out of BOTH sides by default.
  //
  // They dominated the answer completely: a blocked link is never given a
  // posted-date score, so it can only ever put its channel on the rank side,
  // and measured on the live pool all 920 links behind the 829 channels were
  // already blocked. The list was made entirely of work already done. Counting
  // only live links asks the question that has an action attached to it — which
  // channels are we ranking for and getting nothing from RIGHT NOW.
  const includeBlocked = sp.get('includeBlocked') === '1'

  try {
    const { rows } = await buildAdminLinks(String(sp.get('product') ?? ''))
    const pool = rows.filter(
      (l) => (!platform || l.platform === platform) && (includeBlocked || !l.blocked)
    )
    const wanted = clusters.length ? new Set(clusters) : null

    const onRankSide = (l: AdminLinkRow) =>
      l.rankCluster > 0 && (!wanted || wanted.has(l.rankCluster))
    // A score, not merely a bucket — see the note above.
    const onDateSide = (l: AdminLinkRow) =>
      typeof l.date_score === 'number' &&
      l.dateCluster > 0 &&
      (!wanted || wanted.has(l.dateCluster))

    const dateChannels = new Set<string>()
    let dateLinks = 0
    for (const l of pool) {
      if (!onDateSide(l)) continue
      dateLinks++
      const c = channelOf(l.url)
      if (c) dateChannels.add(c)
    }

    const found = new Map<string, ChannelRow>()
    // Keyword -> the best rank this channel reached with it, so the list can be
    // ordered by how well the channel does for each rather than alphabetically.
    const keywordRank = new Map<string, Map<string, number>>()
    const rankChannels = new Set<string>()
    let rankLinks = 0
    for (const l of pool) {
      if (!onRankSide(l)) continue
      rankLinks++
      const c = channelOf(l.url)
      if (!c) continue
      rankChannels.add(c)
      if (dateChannels.has(c)) continue
      const kw = String(l.search_query ?? '').trim()
      if (kw) {
        const m = keywordRank.get(c) ?? new Map<string, number>()
        const rank = l.search_rank > 0 ? l.search_rank : Number.MAX_SAFE_INTEGER
        if (!m.has(kw) || rank < (m.get(kw) as number)) m.set(kw, rank)
        keywordRank.set(c, m)
      }
      const video = {
        url: l.url,
        title: String(l.title ?? ''),
        rank: l.search_rank || 0,
        cluster: l.rankCluster,
        keyword: kw,
        blocked: l.blocked,
      }
      const cur = found.get(c)
      if (!cur) {
        found.set(c, {
          channel: c,
          ...splitChannel(c),
          links: 1,
          bestCluster: l.rankCluster,
          bestRank: l.search_rank || 0,
          sample: l.url,
          keywords: [],
          videos: [video],
        })
      } else {
        cur.links++
        cur.videos.push(video)
        if (l.rankCluster < cur.bestCluster) {
          cur.bestCluster = l.rankCluster
          cur.sample = l.url
        }
        if (l.search_rank > 0 && (cur.bestRank === 0 || l.search_rank < cur.bestRank)) {
          cur.bestRank = l.search_rank
        }
      }
    }

    for (const row of Array.from(found.values())) {
      // Best rank first, so the video that earns the channel its place is the
      // one at the top of the list. An unranked link sorts last rather than
      // first, which is what a 0 would do.
      row.videos.sort(
        (a, b) => (a.rank || Number.MAX_SAFE_INTEGER) - (b.rank || Number.MAX_SAFE_INTEGER)
      )
      if (row.videos.length > MAX_VIDEOS_PER_CHANNEL) {
        row.videos = row.videos.slice(0, MAX_VIDEOS_PER_CHANNEL)
      }
      const m = keywordRank.get(row.channel)
      row.keywords = m
        ? Array.from(m.entries())
            .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
            .map(([kw]) => kw)
        : []
    }

    const channels = Array.from(found.values()).sort(
      (a, b) => a.bestCluster - b.bestCluster || b.links - a.links
    )
    let both = 0
    rankChannels.forEach((c) => {
      if (dateChannels.has(c)) both++
    })

    return NextResponse.json({
      ok: true,
      clusters,
      platform,
      includeBlocked,
      channels,
      // The whole picture, so the modal can say what was compared rather than
      // only what fell out of it.
      rankLinks,
      dateLinks,
      rankChannels: rankChannels.size,
      dateChannels: dateChannels.size,
      both,
      dateOnlyChannels: dateChannels.size - both,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
