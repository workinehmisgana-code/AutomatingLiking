// Recomputing the posted-date cluster scores over the whole pool.
//
// Lifted out of the admin route so the automatic pipeline reclusters by exactly
// the same rules the button does.
//
// Scoring normally happens at upload. This exists because the score is RELATIVE
// — recency and hearts are percentiles across the pool — so it drifts as links
// are blocked or added, and it is stale outright after the weights change.
// Blocked links are excluded from the population, not merely skipped: leaving
// them in would let links nobody can ever be served distort the percentiles for
// the links that are.

import { list, put } from '@vercel/blob'
import { type DateWeights } from './config'
import { getBlockedUrls, getDateWeights, getLinkStats, type LinkStat } from './db'
import { overlayStats } from './linkStats'
import { computeDateScores, type Scorable } from './dateScore'

type Video = Record<string, unknown> & { url?: unknown }

export interface ReclusterResult {
  weights: DateWeights
  scored: number
  skippedBlocked: number
  total: number
}

export async function reclusterPool(explicit?: DateWeights): Promise<ReclusterResult> {
  const weights = explicit ?? (await getDateWeights())
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('Blob storage is not configured.')
  }
  const { blobs } = await list({ prefix: 'videos.json' })
  if (!blobs.length) return { weights, scored: 0, skippedBlocked: 0, total: 0 }

  const res = await fetch(blobs[0].url, {
    headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
    cache: 'no-store',
  })
  const data = await res.json()
  const videos: Video[] = Array.isArray(data) ? data : []
  if (videos.length === 0) return { weights, scored: 0, skippedBlocked: 0, total: 0 }

  // Refreshed counts first — otherwise a recluster scores the stale numbers
  // straight back over the fresh ones. The same rows carry is_photo, which
  // decides the video component far more accurately than the URL can.
  const stats = await getLinkStats().catch(() => ({}) as Record<string, LinkStat>)
  overlayStats(videos, stats)
  const blocked = new Set(await getBlockedUrls().catch(() => [] as string[]))
  const active = videos.filter((v) => !blocked.has(String(v.url ?? '')))

  // Mutates the rows in place, so untouched blocked entries stay exactly as they
  // were and keep their position in the file.
  const scored = computeDateScores(active as Scorable[], weights, (url) => stats[url]?.isPhoto)

  await put('videos.json', JSON.stringify(videos), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  })
  return { weights, scored, skippedBlocked: videos.length - active.length, total: videos.length }
}
