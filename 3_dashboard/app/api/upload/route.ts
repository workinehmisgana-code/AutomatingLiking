import { list, put } from '@vercel/blob'
import { NextRequest, NextResponse } from 'next/server'
import { saveLinkTitles, getBlockedUrls, getDateWeights, getLinkStats, type LinkStat } from '@/lib/db'
import { overlayStats } from '@/lib/linkStats'
import { computeDateScores } from '@/lib/dateScore'
import { DEFAULT_DATE_WEIGHTS } from '@/lib/config'

type Video = Record<string, unknown> & {
  url?: unknown
  search_query?: unknown
  platform?: unknown
  title?: unknown
}

/**
 * Pull the scraped `title` off each incoming row and DELETE it from the row.
 *
 * Titles are cached in the `link_title` table, never in videos.json: that blob is
 * re-read in full on every dashboard render, and ~37k captions would add several
 * MB to every one of those reads for data the pages already get from the DB.
 *
 * Mutates `rows` in place. Returns { url: title } for the ones worth keeping.
 */
function takeTitles(rows: Video[]): Record<string, string> {
  const titles: Record<string, string> = {}
  for (const v of rows) {
    const url = String(v.url ?? '').trim()
    const title = String(v.title ?? '').trim()
    // Always strip the field, even when blank, so it can never reach the blob.
    if ('title' in v) delete v.title
    if (url && title) titles[url] = title
  }
  return titles
}

function platformOf(v: Video): string {
  return String(v.platform ?? 'unknown')
}

/** Refresh a stored link's fields from a fresh upload of the same URL: the
 *  engagement (like/heart or view) count and the search rank. Each is only
 *  overwritten with a VALID POSITIVE value that differs — so a scrape that
 *  momentarily returned 0/blank never wipes a real value. Returns true if any
 *  field changed. */
function refreshLink(stored: Video, incoming: Video): boolean {
  let changed = false
  // Engagement (like/heart or view) count.
  const nextLikes = Number(incoming.like_count)
  const curLikes = Number(stored.like_count)
  if (Number.isFinite(nextLikes) && nextLikes > 0 && nextLikes !== curLikes) {
    stored.like_count = nextLikes
    changed = true
  }
  // Search rank (position in the search results for its keyword).
  const nextRank = Number(incoming.search_rank)
  const curRank = Number(stored.search_rank)
  if (Number.isFinite(nextRank) && nextRank > 0 && nextRank !== curRank) {
    stored.search_rank = nextRank
    changed = true
  }
  return changed
}

/** Dedup key: the video URL itself (normalised), so a link is never stored
 *  twice — even if the same video was scraped under several keywords. Strips
 *  query params and any trailing slash so near-identical URLs collapse to one.
 *  EXCEPTION: YouTube watch URLs identify the video by the ?v= query param, so we
 *  keep that — otherwise every YouTube video would collapse to ".../watch". */
function urlKey(v: Video): string {
  const raw = String(v.url ?? '').trim()
  if (!raw) return ''
  const vid = raw.match(/[?&]v=([A-Za-z0-9_-]{6,})/)
  if (vid && /youtube\.com\/watch/i.test(raw)) {
    return raw.split('?')[0].replace(/\/+$/, '') + '?v=' + vid[1]
  }
  return raw.split('?')[0].replace(/\/+$/, '')
}

async function loadExisting(): Promise<Video[]> {
  const { blobs } = await list({ prefix: 'videos.json' })
  if (!blobs.length) return []
  const res = await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? (data as Video[]) : []
}

/** Keep one row per URL, preserving order (first occurrence wins). */
function dedupeByUrl(rows: Video[]): Video[] {
  const byUrl = new Map<string, Video>()
  for (const v of rows) {
    const k = urlKey(v)
    if (!k) continue
    if (!byUrl.has(k)) byUrl.set(k, v)
  }
  return Array.from(byUrl.values())
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-upload-secret')
  if (!secret || secret !== process.env.UPLOAD_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: 'BLOB_READ_WRITE_TOKEN is not set on the server. Add it in Vercel → Settings → Environment Variables, then redeploy.' },
      { status: 500 }
    )
  }

  let incoming: Video[]
  try {
    const body = await req.json()
    if (!Array.isArray(body)) throw new Error('Expected array')
    incoming = body as Video[]
  } catch {
    return NextResponse.json({ error: 'Invalid JSON — expected array of video objects' }, { status: 400 })
  }

  // Harvest + strip titles before anything looks at the rows. saveLinkTitles
  // upserts, so a re-upload refreshes a title, and it drops login-wall/placeholder
  // junk on its own.
  const titles = takeTitles(incoming)
  let titlesSaved = 0

  const modeParam = req.nextUrl.searchParams.get('mode')
  const mode = modeParam === 'append' ? 'append' : modeParam === 'dedupe' ? 'dedupe' : 'replace'

  let videos: Video[]
  let replacedPlatforms: string[] = []
  let added = 0
  let removed = 0
  let updated = 0
  let protectedDateOnly = 0

  // An upload is a search-rank scrape, and it may only touch search-rank links.
  //
  // A link with no search rank takes part ONLY in the posted-date clusters —
  // it came from the verify list, not from a keyword search — and 121,110 of
  // the 130,184 stored links are in that state. A platform-scoped replace used
  // to drop every stored link of the incoming platforms that was not in the
  // batch, which for a TikTok upload meant deleting 93% of the pool. Now they
  // are neither dropped nor edited: an upload cannot reach them at all.
  const dateClusteredOnly = (v: Video): boolean =>
    v.date_only === true || !(Number(v.search_rank) > 0)

  if (mode === 'dedupe') {
    // Clean the stored data in place: keep one row per URL, drop duplicates.
    const existing = await loadExisting()
    videos = dedupeByUrl(existing)
    removed = existing.length - videos.length
  } else if (mode === 'append') {
    // Add genuinely new URLs; for URLs already stored, refresh their like/view
    // count and search rank if the new upload has different (valid) values —
    // otherwise leave the existing row untouched (never duplicated).
    const existing = await loadExisting()
    const byUrl = new Map<string, Video>()
    for (const v of existing) {
      const k = urlKey(v)
      if (k) byUrl.set(k, v)
    }
    for (const v of incoming) {
      const k = urlKey(v)
      if (!k) continue
      const stored = byUrl.get(k)
      if (!stored) {
        byUrl.set(k, v)
        added++
      } else if (dateClusteredOnly(stored)) {
        // Already stored, and posted-date only. Leave it exactly as it is —
        // refreshing it would rewrite a link this upload has no business in.
        protectedDateOnly++
      } else if (refreshLink(stored, v)) {
        updated++
      }
    }
    videos = Array.from(byUrl.values())
  } else {
    // Platform-scoped replace: only the platforms present in the incoming batch
    // are replaced; links for other platforms are left untouched. The incoming
    // batch is also deduped by URL so a single upload can't introduce dupes.
    //
    // A URL that is ALREADY stored is UPDATED, not re-created: its stored row is
    // kept (so everything the dashboard added to it later — cached title, flags,
    // date_only, source_file … — survives) and only its like/view count and
    // search rank are refreshed from the new scrape. Stored links of these
    // platforms that are absent from the batch are dropped, as "replace" implies.
    const existing = await loadExisting()
    const incomingPlatforms = new Set(incoming.map(platformOf))
    replacedPlatforms = Array.from(incomingPlatforms)
    // Kept: every link of an untouched platform, AND every posted-date-only
    // link regardless of platform. Only search-rank links of the incoming
    // platforms are up for replacement.
    const kept = existing.filter(
      (v) => !incomingPlatforms.has(platformOf(v)) || dateClusteredOnly(v)
    )
    protectedDateOnly = existing.filter(
      (v) => incomingPlatforms.has(platformOf(v)) && dateClusteredOnly(v)
    ).length
    const storedForPlatforms = new Map<string, Video>()
    for (const v of existing) {
      const k = urlKey(v)
      if (k && incomingPlatforms.has(platformOf(v)) && !dateClusteredOnly(v)) {
        storedForPlatforms.set(k, v)
      }
    }
    // URLs that are already stored as posted-date-only. dedupeByUrl keeps the
    // FIRST of a duplicate and `kept` goes in first, so the stored row would
    // win anyway — but skipping them here keeps the counts honest instead of
    // reporting links as "added" that are then silently dropped.
    const protectedUrls = new Set<string>()
    for (const v of existing) {
      if (!dateClusteredOnly(v)) continue
      const k = urlKey(v)
      if (k) protectedUrls.add(k)
    }
    const byUrl = new Map<string, Video>()
    let reused = 0
    for (const v of incoming) {
      const k = urlKey(v)
      if (!k || byUrl.has(k) || protectedUrls.has(k)) continue
      const stored = storedForPlatforms.get(k)
      if (stored) {
        if (refreshLink(stored, v)) updated++
        byUrl.set(k, stored)
        reused++
      } else {
        byUrl.set(k, v)
        added++
      }
    }
    removed = storedForPlatforms.size - reused
    videos = dedupeByUrl([...kept, ...Array.from(byUrl.values())])
  }

  // Re-score the pool for the posted-date clusters. It runs on every upload
  // because the score is relative: recency and hearts are percentiles
  // across all links, so adding a batch shifts where the existing ones sit.
  // Scoring only the new rows would put them on a different scale and scramble
  // the clustering.
  //
  // BLOCKED links are excluded from the population — they can never be served,
  // so letting them skew the percentiles would distort the links that can. This
  // matches the Recluster button exactly; if the two disagreed, pressing it after
  // an upload would silently rewrite every score.
  //
  // The weights are the admin-set ones (Recluster modal), not the compiled
  // defaults — otherwise the next upload would silently undo the weighting the
  // admin last applied.
  const [blockedList, dateWeights] = await Promise.all([
    getBlockedUrls().catch(() => [] as string[]),
    getDateWeights().catch(() => DEFAULT_DATE_WEIGHTS),
  ])
  const blockedNow = new Set(blockedList)
  const linkStats = await getLinkStats().catch(() => ({}) as Record<string, LinkStat>)
  overlayStats(videos as unknown as { url?: unknown }[], linkStats)
  const scored = computeDateScores(
    videos.filter((v) => !blockedNow.has(String(v.url ?? ''))),
    dateWeights,
    // Same photo flags as the Recluster button, so an upload cannot silently
    // score a known carousel back up as if it were a video.
    (url) => linkStats[url]?.isPhoto
  )

  // Cache the titles even if the blob write fails — they're independent, and a
  // failure here must not lose the links themselves.
  if (Object.keys(titles).length > 0) {
    titlesSaved = await saveLinkTitles(titles).catch(() => 0)
  }

  try {
    const blob = await put('videos.json', JSON.stringify(videos), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    })
    return NextResponse.json({
      ok: true,
      mode,
      received: incoming.length,
      added,
      updated,
      removed,
      // Posted-date-only links this upload deliberately did not touch. Worth
      // reporting: it is usually far larger than everything else on this line.
      protectedDateOnly,
      titlesSaved,
      scored,
      count: videos.length,
      replacedPlatforms,
      url: blob.url,
    })
  } catch (e) {
    return NextResponse.json({ error: `Blob write failed: ${String(e)}` }, { status: 500 })
  }
}
