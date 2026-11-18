import { list, put } from '@vercel/blob'
import { NextRequest, NextResponse } from 'next/server'
import { invalidatePoolFile } from '@/lib/videos'
import {
  saveLinkTitles,
  getBlockedIndex,
  getDateWeights,
  getLinkStats,
  getAllVerifyLinkUrls,
  saveVerifyLinks,
  type LinkStat,
} from '@/lib/db'
import { classifyRelatedByGenre } from '@/lib/titleClassify'
import { overlayStats } from '@/lib/linkStats'
import { computeDateScores } from '@/lib/dateScore'
import { DEFAULT_DATE_WEIGHTS, DEFAULT_GENRE, genreOfRow, isGenre, repairRowPlatform } from '@/lib/config'
import { ensureGenreRegistry } from '@/lib/genreStore'

// The title check (below) can take a while on a big batch: up to 100 titles a
// model call, all calls at once.
export const maxDuration = 60

/** How long the title check may take before the upload goes ahead without it. */
const CHECK_BUDGET_MS = 35_000

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
  // THE GENRE, OR A RE-UPLOAD SILENTLY LOSES IT. This function is the only
  // thing that touches a row we already hold, and it copied two numbers — so
  // re-scraping a website keyword that happens to return a link already in the
  // pool would leave that link reading as humanizer for ever.
  //
  // Only ever SET, never cleared: an upload that forgot to say which genre it
  // was must not be able to blank one that is already right.
  if (isGenre(incoming.genre) && incoming.genre !== stored.genre) {
    stored.genre = incoming.genre
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
  return Array.isArray(data) ? (data as Video[]).map(repairRowPlatform) : []
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
  // The added genres, current to the minute, before GENRES is read.
  await ensureGenreRegistry().catch(() => {})
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

  // WHICH GENRE'S POOL THIS UPLOAD IS FOR, carried as one query param rather
  // than as a column on every row: a search run has exactly one genre, so a
  // column would repeat the same word two hundred times a file and would have to
  // be threaded through four duplicated CSV writers to say it.
  //
  // An unrecognised or missing value is DEFAULT_GENRE, not an error. Uploads come
  // from a desktop app that can be older than this deploy, and refusing the whole
  // file would lose a scrape; reading it as humanizer is what every pre-genre
  // upload already means.
  const genreParam = req.nextUrl.searchParams.get('genre')
  const genre = isGenre(genreParam) ? genreParam : DEFAULT_GENRE
  for (const v of incoming) {
    v.genre = genre
    // An older upload.py tags a Reddit post 'unknown'; the URL says Reddit.
    repairRowPlatform(v)
  }

  // ── THE TITLE CHECK: is each NEW link related to its genre? ──
  //
  // A keyword search brings back plenty that is not ours. Every link this upload
  // would ADD is judged by its title (and its channel's bio) with the same rule
  // as "Mark unrelated". Related ones go into the pool, in the search clusters,
  // as always. Unrelated ones are STAGED in Links to verify instead, keeping
  // their keyword and rank: verifying one by hand merges it into the SEARCH
  // clusters (lib/verifyMerge), not the posted-date ones.
  //
  // Not judged, and so going in as before: links already in the pool (they were
  // accepted once), links with no title (nothing to judge), and the whole batch
  // when the check fails or runs out of time — an upload never loses links to a
  // model outage. A link ALREADY waiting in Links to verify stays there (its
  // rank refreshed) rather than slipping in through a re-upload.
  const existingPool = mode === 'dedupe' ? [] : await loadExisting()
  const loadExistingOnce = async (): Promise<Video[]> => existingPool
  let staged = 0
  let checked = 0
  let checkError = ''
  if (mode !== 'dedupe' && incoming.length > 0) {
    const inPool = new Set(existingPool.map(urlKey).filter(Boolean))
    const waiting = new Set(await getAllVerifyLinkUrls().catch(() => [] as string[]))
    const toStage = new Set<string>()
    const candidates: { url: string; title: string; genre: string }[] = []
    for (const v of incoming) {
      const url = String(v.url ?? '').trim()
      if (!url || inPool.has(urlKey(v))) continue
      if (waiting.has(url)) toStage.add(url)
      else if (titles[url]) candidates.push({ url, title: titles[url], genre })
    }
    if (candidates.length > 0) {
      try {
        const related = await Promise.race([
          classifyRelatedByGenre(candidates),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`the title check took over ${CHECK_BUDGET_MS / 1000} s`)), CHECK_BUDGET_MS)
          ),
        ])
        const rel = new Set(related)
        checked = candidates.length
        for (const c of candidates) if (!rel.has(c.url)) toStage.add(c.url)
      } catch (e) {
        checkError = String(e instanceof Error ? e.message : e).slice(0, 300)
      }
    }
    if (toStage.size > 0) {
      const rows = incoming.filter((v) => toStage.has(String(v.url ?? '').trim()))
      const written = await saveVerifyLinks(
        rows.map((v) => ({
          url: String(v.url ?? '').trim(),
          account: String(v.author ?? ''),
          // A search grid's like_count is views on TikTok (see upload.py).
          view_count: v.like_count,
          heart_count: v.heart_count,
          posted_date: v.posted_date,
          title: titles[String(v.url ?? '').trim()] ?? '',
          genre,
          search_query: v.search_query,
          search_rank: Number(v.search_rank) > 0 ? v.search_rank : 1,
        }))
      ).catch((e) => {
        checkError = checkError || `could not stage: ${String(e).slice(0, 200)}`
        return -1
      })
      // Only held back once they are safely staged; otherwise they go in as before.
      if (written >= 0) {
        incoming = incoming.filter((v) => !toStage.has(String(v.url ?? '').trim()))
        staged = toStage.size
      }
    }
  }

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
    const existing = await loadExistingOnce()
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
    const existing = await loadExistingOnce()
    const incomingPlatforms = new Set(incoming.map(platformOf))
    replacedPlatforms = Array.from(incomingPlatforms)
    // Kept: every link of an untouched platform, AND every posted-date-only
    // link regardless of platform. Only search-rank links of the incoming
    // platforms are up for replacement.
    //
    // AND ONLY THIS UPLOAD'S GENRE. A replace is "this search is the whole of
    // this genre's search-rank links on these platforms" — it says nothing
    // about another genre's. Scoped by platform alone, a humanizer TikTok
    // upload dropped every website-builder TikTok link in the pool, which is
    // how the cocodly links served on 2026-10-17 left the pool by the 18th.
    // Another genre's link that this batch re-uploads is the exception: it is
    // taken over (refreshLink re-stamps its genre), not kept twice.
    const incomingKeys = new Set(incoming.map(urlKey).filter(Boolean))
    const sameGenre = (v: Video): boolean => genreOfRow({ genre: v.genre }) === genre
    const kept = existing.filter(
      (v) =>
        !incomingPlatforms.has(platformOf(v)) ||
        dateClusteredOnly(v) ||
        (!sameGenre(v) && !incomingKeys.has(urlKey(v)))
    )
    protectedDateOnly = existing.filter(
      (v) => incomingPlatforms.has(platformOf(v)) && dateClusteredOnly(v)
    ).length
    const storedForPlatforms = new Map<string, Video>()
    for (const v of existing) {
      const k = urlKey(v)
      if (
        k &&
        incomingPlatforms.has(platformOf(v)) &&
        !dateClusteredOnly(v) &&
        (sameGenre(v) || incomingKeys.has(k))
      ) {
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
  const [blockedIndex, dateWeights] = await Promise.all([
    getBlockedIndex().catch(() => new Map<string, Set<string>>()),
    getDateWeights().catch(() => DEFAULT_DATE_WEIGHTS),
  ])
  const linkStats = await getLinkStats().catch(() => ({}) as Record<string, LinkStat>)
  overlayStats(videos as unknown as { url?: unknown }[], linkStats)
  const scored = computeDateScores(
    // Blocked FOR THE ROW'S OWN GENRE — the rows are in hand, so no index of
    // the old pool is needed (and this upload may just have re-filed some).
    videos.filter(
      (v) => !blockedIndex.get(String(v.url ?? ''))?.has(genreOfRow({ genre: v.genre }))
    ),
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
    // The pool file is being replaced, so the cached copy of it is wrong from
    // this moment; the next reader downloads the new one.
    invalidatePoolFile()
    const blob = await put('videos.json', JSON.stringify(videos), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    })
    return NextResponse.json({
      ok: true,
      mode,
      genre,
      received: incoming.length + staged,
      added,
      // The title check: new links judged, those held back in Links to verify
      // as unrelated, and why the check did not run when it did not.
      checked,
      stagedUnrelated: staged,
      checkError,
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
