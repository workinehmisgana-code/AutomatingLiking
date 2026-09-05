import { NextResponse, type NextRequest } from 'next/server'
import { put } from '@vercel/blob'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { loadVideosJson } from '@/lib/videos'
import {
  getBlockedLinksPage,
  getBlockedLinkUrls,
  getBlockedChannels,
  getBlockedUrlsForChannels,
  unblockLinks,
  blockLinks,
  getLinkStats,
  type LinkStat,
  type BlockedSort,
} from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Browse and edit the permanent block list.
//
// This reads blocked_link directly rather than the pool. Blocking never removed
// anything from videos.json, but uploads and merges have replaced the pool many
// times since, so ~97k of the 99k blocked URLs no longer have a pool row — they
// are invisible to the Links page's "blocked only" filter, which can only mark
// rows it already has.
//
// Each row is flagged `inPool`, because that decides what unblocking DOES: a
// blocked link still in the pool goes straight back into circulation, while one
// that is gone stays gone until an upload re-adds it. Without the flag an admin
// would unblock 500 links and see nothing happen.

const PAGE_MAX = 200

/** The TikTok video id in a URL — the identity the pool is de-duped on. */
function videoId(url: string): string | null {
  return url.match(/\/(?:video|photo)\/(\d+)/)?.[1] ?? null
}

/**
 * Put unblocked links that are no longer in the pool back into it.
 *
 * Lifting a block on a link that has since dropped out of videos.json used to
 * change nothing a user could see: the filter stopped applying to a link that
 * was not there to serve. Unblocking plainly means "let people work on this
 * again", so the link is restored.
 *
 * The restored row is minimal — no search rank, so it clusters by posted date
 * like a channel-merged link — but its like count is recovered from link_stat
 * when a refresh has ever read one. It has no date_score until the next
 * recluster, which sorts it last rather than wrongly.
 *
 * Returns how many were added. Writes videos.json only when there is something
 * to add: it is a 24 MB blob.
 */
async function restoreToPool(urls: string[]): Promise<number> {
  const tiktok = urls.filter((u) => videoId(u))
  if (tiktok.length === 0) return 0
  if (!process.env.BLOB_READ_WRITE_TOKEN) return 0

  const videos = (await loadVideosJson().catch(() => [])) as Record<string, unknown>[]
  const present = new Set(
    videos.map((v) => videoId(String(v.url ?? ''))).filter((x): x is string => !!x)
  )
  const missing = tiktok.filter((u) => !present.has(videoId(u) as string))
  if (missing.length === 0) return 0

  const stats = await getLinkStats().catch(() => ({}) as Record<string, LinkStat>)
  const now = new Date().toISOString()
  for (const url of missing) {
    const hearts = stats[url]?.hearts ?? null
    videos.push({
      url,
      platform: 'tiktok',
      search_query: '',
      search_rank: 0,
      like_count: hearts ?? 0,
      ...(hearts !== null ? { heart_count: hearts } : {}),
      posted_date: '',
      scraped_at: now,
      // No rank, so it belongs to the posted-date clusters only — the same
      // shape a channel-merged link has.
      date_only: true,
    })
  }
  await put('videos.json', JSON.stringify(videos), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  })
  return missing.length
}

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const sp = req.nextUrl.searchParams
  const q = sp.get('q') ?? ''

  // count=1 → just the size of the block list. Used for the button label, so it
  // must not pay the 24 MB pool read that a full page does.
  if (sp.get('count') === '1') {
    try {
      const { matched } = await getBlockedLinksPage({ offset: 0, limit: 1, q })
      return NextResponse.json({ matched })
    } catch (e) {
      return NextResponse.json({ error: `Could not count: ${String(e)}` }, { status: 500 })
    }
  }

  // channels=1 → the list collapsed to one row per channel. 100k rows is
  // unreadable link by link; "which channels am I rejecting" is answerable.
  if (sp.get('channels') === '1') {
    const offset = Math.max(0, Number(sp.get('offset')) || 0)
    const limit = Math.min(PAGE_MAX, Math.max(1, Number(sp.get('limit')) || 100))
    const sortRaw = sp.get('sort')
    const sort: BlockedSort = sortRaw === 'oldest' || sortRaw === 'url' ? sortRaw : 'recent'
    try {
      const page = await getBlockedChannels({ offset, limit, q, sort })
      return NextResponse.json({ ...page, offset, limit })
    } catch (e) {
      return NextResponse.json({ error: `Could not group by channel: ${String(e)}` }, { status: 500 })
    }
  }

  // urls=1 → every matching URL, for "select all matching". No pool load needed.
  if (sp.get('urls') === '1') {
    try {
      return NextResponse.json({ urls: await getBlockedLinkUrls(q) })
    } catch (e) {
      return NextResponse.json({ error: `Could not list: ${String(e)}` }, { status: 500 })
    }
  }

  const offset = Math.max(0, Number(sp.get('offset')) || 0)
  const limit = Math.min(PAGE_MAX, Math.max(1, Number(sp.get('limit')) || 100))
  const sortRaw = sp.get('sort')
  const sort: BlockedSort =
    sortRaw === 'oldest' || sortRaw === 'url' ? sortRaw : 'recent'

  try {
    const [page, videos] = await Promise.all([
      getBlockedLinksPage({ offset, limit, q, sort }),
      loadVideosJson().catch(() => []),
    ])
    const inPool = new Set(videos.map((v) => String(v.url ?? '')))
    return NextResponse.json({
      rows: page.rows.map((r) => ({ ...r, inPool: inPool.has(r.url) })),
      matched: page.matched,
      offset,
      limit,
    })
  } catch (e) {
    return NextResponse.json({ error: `Could not load the block list: ${String(e)}` }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown
    urls?: unknown
    handles?: unknown
  }
  const action = String(body.action ?? '')
  // `handles` unblocks whole channels — a block is usually a judgement about a
  // channel, so undoing one link at a time would be the wrong unit of work.
  const handles = Array.isArray(body.handles) ? body.handles.map((h) => String(h)) : []
  const urls = handles.length > 0
    ? await getBlockedUrlsForChannels(handles).catch(() => [] as string[])
    : Array.isArray(body.urls) ? body.urls.map((u) => String(u)) : []
  if (urls.length === 0) {
    return NextResponse.json({ error: 'No links given.' }, { status: 400 })
  }
  if (action !== 'unblock' && action !== 'block') {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  }
  try {
    // block is here so an accidental unblock can be undone in one click, from
    // the same screen, without hunting the links down again.
    if (action === 'block') {
      const n = await blockLinks(urls)
      return NextResponse.json({ ok: true, action, changed: n })
    }
    const n = await unblockLinks(urls)
    // Restore AFTER the block is lifted, so a link can never be back in the pool
    // while still filtered out of every serve path.
    const restored = await restoreToPool(urls).catch(() => 0)
    return NextResponse.json({ ok: true, action, changed: n, restored })
  } catch (e) {
    return NextResponse.json({ error: `Could not ${action}: ${String(e)}` }, { status: 500 })
  }
}
