import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { loadVideosJson } from '@/lib/videos'
import { saveVerifyLinks, getAllVerifyLinkUrls, getBlockedUrls } from '@/lib/db'
import { rankChannels, handleOf } from '@/lib/channelRank'
import { fetchChannelVideos, fetchVideoDetail } from '@/lib/linkStats'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Pull each channel's NEW videos into the verify staging list.
//
// Nothing here touches videos.json. New links land in verify_link only, so they
// show up on the Links-to-verify page to be reviewed and merged by hand.
//
// Batched like the count refresh: the client posts an offset into the ranked
// channel list, this works to a deadline and says where to resume.
//
// A video is NEW when it was posted AFTER the newest video we already hold for
// that channel, and its id is in neither the pool, the verify list, nor the
// blocked list.
//
// The "posted after" half is what makes this an update rather than an import.
// Unseen is not the same as new: a channel first picked up last month has years
// of earlier videos we have never held, and staging those is re-importing a back
// catalogue, not catching up. Recency is read from the video id, which carries
// its creation time — the channel listing has no date in it.
//
// Blocked links count as held, or a link rejected once would be re-staged on
// every single run, and dropping it from the mark would drag the mark backwards.

/** GET — the ranked channel list, so the page can show the order first. */
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const channels = await rankChannels()
    return NextResponse.json({ channels, total: channels.length })
  } catch (e) {
    return NextResponse.json({ error: `Could not rank channels: ${String(e)}` }, { status: 500 })
  }
}

/** Leave room to write rows and respond inside maxDuration. */
const BUDGET_MS = 40_000
/** Channels whose listings are fetched at once. */
const CHANNEL_CONCURRENCY = 6
/** Detail fetches per new video, in parallel within one channel. */
const DETAIL_CONCURRENCY = 4
const MAX_CHANNELS = 200

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    offset?: unknown
    limit?: unknown
    handles?: unknown
  }
  const offset = Math.max(0, Number(body.offset) || 0)
  const limit = Math.min(MAX_CHANNELS, Math.max(1, Number(body.limit) || MAX_CHANNELS))
  // The channels the admin actually filtered down to, in the order the table
  // shows them. Sent explicitly rather than re-derived here: the filters live in
  // the browser, and re-ranking server-side could silently choose a different
  // set from the one on screen.
  const only = Array.isArray(body.handles)
    ? body.handles.map((h) => String(h).replace(/^@/, '').trim().toLowerCase()).filter(Boolean)
    : []

  let channels: { handle: string }[]
  /** Channels dropped because this route can only fetch from TikTok. */
  let skippedOtherSites = 0
  let known: Set<string>
  /** Newest video id we already hold for each channel — the high-water mark. */
  let newestByHandle: Map<string, bigint>
  try {
    const [ranked, videos, staged, blocked] = await Promise.all([
      rankChannels(),
      loadVideosJson().catch(() => []),
      getAllVerifyLinkUrls().catch(() => [] as string[]),
      getBlockedUrls().catch(() => [] as string[]),
    ])
    if (only.length > 0) {
      // Keep the client's order, and drop anything that is not a real ranked
      // channel — a handle typed or stale in the browser must not reach TikTok.
      const known = new Map(ranked.map((c) => [c.handle.toLowerCase(), c]))
      channels = only.map((h) => known.get(h)).filter((c): c is (typeof ranked)[number] => !!c)
    } else {
      channels = ranked
    }
    // TikTok only: everything below reads a TikTok snowflake id out of the URL
    // to decide what is new, and fetches listings from tiktok.com/embed/@handle.
    // There is no Instagram or YouTube equivalent here. Those channels are
    // dropped and COUNTED — silently contributing nothing makes a run of 2,000
    // Instagram channels look broken rather than unsupported.
    const before = channels.length
    channels = channels.filter(
      (c) => ((c as { platform?: string }).platform ?? 'tiktok') === 'tiktok'
    )
    skippedOtherSites = before - channels.length
    // Match on the numeric video id, not the URL: the same video appears with
    // and without query strings, and as /video/ or /photo/.
    known = new Set<string>()
    // A TikTok video id carries its creation time in the top 32 bits, so a
    // larger id means a later post. Checked against 3,070 scraped links: on the
    // rows whose scraped date is unambiguous, the id's date lands within two
    // days 99% of the time and 510 of 513 consecutive pairs agree on order.
    // That is what lets "newer than" be decided from the listing alone, which
    // carries an id and a caption but no date.
    newestByHandle = new Map<string, bigint>()
    const add = (u: string) => {
      const m = u.match(/\/(?:video|photo)\/(\d+)/)
      if (!m) return
      known.add(m[1])
      const handle = handleOf(u)
      if (!handle) return
      try {
        const id = BigInt(m[1])
        const cur = newestByHandle.get(handle)
        if (cur === undefined || id > cur) newestByHandle.set(handle, id)
      } catch {
        // Not a number we can compare. It still counts as known.
      }
    }
    for (const v of videos) add(String(v.url ?? ''))
    for (const u of staged) add(u)
    // Blocked links count toward the mark as well. A video we saw and rejected
    // is still a video we have been past, and ignoring it here would drag the
    // mark backwards and re-offer everything posted since.
    for (const u of blocked) add(u)
  } catch (e) {
    return NextResponse.json({ error: `Could not load state: ${String(e)}` }, { status: 500 })
  }

  const total = channels.length
  if (offset >= total) {
    return NextResponse.json({
      ok: true, total, nextOffset: total, done: true, skippedOtherSites,
      channelsChecked: 0, newLinks: 0, olderSkipped: 0, staged: 0, failed: 0,
    })
  }

  const slice = channels.slice(offset, offset + limit)
  const deadline = Date.now() + BUDGET_MS

  const rows: Parameters<typeof saveVerifyLinks>[0] = []
  let consumed = 0
  let failed = 0
  let newLinks = 0
  /** Listed videos passed over for being older than what we already hold. */
  let olderSkipped = 0
  let next = 0

  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return
      const i = next++
      if (i >= slice.length) return
      const handle = slice[i].handle
      const listed = await fetchChannelVideos(handle)
      consumed = Math.max(consumed, i + 1)
      if (listed.length === 0) {
        failed++
        continue
      }
      // Only what the channel posted AFTER the newest video we already hold for
      // it. Without this, "new" meant "any id we have never seen", which pulls
      // in the back catalogue: a channel we first picked up last month has
      // years of older videos that are all unknown to us and none of them are
      // new. A channel we have never touched has no mark, so its whole listing
      // is offered — that is its first extraction.
      const since = newestByHandle.get(handle.toLowerCase()) ?? null
      let olderHere = 0
      const fresh = listed.filter((v) => {
        if (known.has(v.id)) return false
        if (since === null) return true
        try {
          if (BigInt(v.id) > since) return true
          olderHere++
          return false
        } catch {
          // An id that will not parse cannot be placed in time. Let it through
          // and let the review catch it, rather than dropping it silently.
          return true
        }
      })
      olderSkipped += olderHere
      if (fresh.length === 0) continue
      // Detail gives the like/comment/share counts, the channel bio and a real
      // posted date — the listing alone has only id, caption and views.
      for (let k = 0; k < fresh.length; k += DETAIL_CONCURRENCY) {
        if (Date.now() >= deadline) return
        const chunk = fresh.slice(k, k + DETAIL_CONCURRENCY)
        const details = await Promise.all(chunk.map((v) => fetchVideoDetail(v.url)))
        details.forEach((d, n) => {
          const v = chunk[n]
          // Claim the id even on a detail failure, so two channels sharing a
          // reposted video can't stage it twice in one pass.
          if (known.has(v.id)) return
          known.add(v.id)
          newLinks++
          rows.push({
            url: v.url,
            account: d?.account || handle,
            view_count: d?.views ?? v.views ?? 0,
            heart_count: d?.hearts ?? 0,
            comment_count: d?.comments ?? 0,
            share_count: d?.shares ?? 0,
            posted_date: d?.postedDate || '',
            title: d?.title || v.title || '',
            bio: d?.bio || '',
          })
        })
      }
    }
  }
  await Promise.all(Array.from({ length: CHANNEL_CONCURRENCY }, worker))

  let written = 0
  try {
    written = await saveVerifyLinks(rows)
  } catch (e) {
    return NextResponse.json({ error: `Could not stage links: ${String(e)}` }, { status: 500 })
  }

  const nextOffset = offset + Math.max(consumed, 1)
  return NextResponse.json({
    ok: true,
    total,
    nextOffset,
    // Non-TikTok channels the client asked for and this route cannot fetch.
    skippedOtherSites,
    channelsChecked: consumed,
    newLinks,
    // Listed videos passed over as older than our high-water mark for the
    // channel. Worth seeing: a large number here on a first run is the back
    // catalogue that used to be staged as though it were new.
    olderSkipped,
    staged: written,
    failed,
    done: nextOffset >= total,
  })
}
