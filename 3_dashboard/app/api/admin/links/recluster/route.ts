import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { list, put } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { isAdminEmail, type DateWeights, normalizeDateWeights } from '@/lib/config'
import { getBlockedUrls, getDateWeights, setDateWeights, getLinkStats, type LinkStat } from '@/lib/db'
import { overlayStats } from '@/lib/linkStats'
import { computeDateScores, type Scorable } from '@/lib/dateScore'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Video = Record<string, unknown> & { url?: unknown }

// POST — recompute the posted-date cluster scores for every NON-BLOCKED link and
// write them back to videos.json.
//
// Scoring normally happens at upload. This button exists because the score is
// RELATIVE — recency and hearts are percentiles across the pool — so
// it drifts as links are blocked or deleted, and it is stale outright after the
// weights are changed. Blocked links are excluded from the population, not just
// skipped: leaving them in would let links nobody can ever be served distort the
// percentiles for the links that are.
// GET — the weights currently in force, so the modal opens on the real values
// rather than on the compiled defaults.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return NextResponse.json({ weights: await getDateWeights() })
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Weights from the modal, if it sent any. They are SAVED before scoring, so an
  // upload later on scores with the same weights the admin last applied here
  // instead of quietly reverting the pool to the compiled defaults.
  let weights: DateWeights
  const body = await req.json().catch(() => null)
  if (body && typeof body === 'object' && 'weights' in body) {
    const w = normalizeDateWeights((body as { weights: Partial<DateWeights> }).weights)
    weights = await setDateWeights(w)
  } else {
    weights = await getDateWeights()
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'Blob storage is not configured.' }, { status: 500 })
  }
  try {
    const { blobs } = await list({ prefix: 'videos.json' })
    if (!blobs.length) return NextResponse.json({ ok: true, weights, scored: 0, skippedBlocked: 0, total: 0 })
    const res = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
    const data = await res.json()
    const videos: Video[] = Array.isArray(data) ? data : []
    if (videos.length === 0) return NextResponse.json({ ok: true, weights, scored: 0, skippedBlocked: 0, total: 0 })

    // Refreshed counts first — otherwise a recluster scores the stale numbers
    // straight back over the fresh ones. The same rows carry is_photo, which
    // decides the video component far more accurately than the URL can.
    const stats = await getLinkStats().catch(() => ({}) as Record<string, LinkStat>)
    overlayStats(videos, stats)
    const blocked = new Set(await getBlockedUrls().catch(() => [] as string[]))
    const active = videos.filter((v) => !blocked.has(String(v.url ?? '')))

    // Mutates the rows in place, so the untouched blocked entries stay exactly
    // as they were and keep their position in the file.
    const scored = computeDateScores(active as Scorable[], weights, (url) => stats[url]?.isPhoto)

    await put('videos.json', JSON.stringify(videos), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    })
    return NextResponse.json({
      ok: true,
      weights,
      scored,
      skippedBlocked: videos.length - active.length,
      total: videos.length,
    })
  } catch (e) {
    return NextResponse.json({ error: `Recluster failed: ${String(e)}` }, { status: 500 })
  }
}
