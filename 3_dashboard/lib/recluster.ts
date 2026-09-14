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
import {
  getAppState,
  getBlockedUrls,
  getDateWeights,
  getLinkStats,
  setAppState,
  type LinkStat,
} from './db'
import { overlayStats } from './linkStats'
import { computeDateScores, type Scorable } from './dateScore'
import { releaseLock, takeLock } from './poolLock'

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


// ── The hourly recluster ─────────────────────────────────────────────────────
//
// The score is RELATIVE — recency and hearts are percentiles across the pool —
// so it goes stale on its own, without anyone touching the weights: every new
// link shifts where the existing ones sit, and every block removes one from the
// population. The six-hourly pipeline reclusters at the end of its lap, but a
// lap takes hours of working time, so between laps the clusters drift.
//
// Cheap enough to do hourly and no cheaper: it reads the whole 38 MB pool
// (133,199 links), rescores it and writes it back. That is ~1.8 GB of blob
// traffic a day, which is the reason this is hourly rather than every few
// minutes.

export const RECLUSTER_EVERY_HOURS = 1
const LAST_KEY = 'recluster_last'
/** Long enough to cover a slow read-rescore-write of the whole pool. */
const HOLD_MS = 5 * 60_000

export interface ReclusterTick {
  ran: boolean
  /** Why it did not run, when it did not. */
  reason?: 'not-due' | 'busy'
  lastAt: string | null
  dueAt: string | null
  everyHours: number
  result?: ReclusterResult
}

/**
 * Recluster if an hour has passed since the last one.
 *
 * The schedule fires on the hour, but the DUE check is what decides — a missed
 * or retried cron then costs nothing and skips nothing, and an admin hitting the
 * route by hand cannot force a rescore of the whole pool by refreshing.
 *
 * Shares the pipeline's lock. Both rewrite videos.json in full, and two of those
 * at once would mean one write silently losing the other.
 */
export async function reclusterIfDue(
  everyHours: number = RECLUSTER_EVERY_HOURS
): Promise<ReclusterTick> {
  const now = Date.now()
  const raw = Number(await getAppState(LAST_KEY).catch(() => null))
  const last = Number.isFinite(raw) && raw > 0 ? raw : 0
  const dueAt = last + everyHours * 3_600_000
  const state = {
    lastAt: last ? new Date(last).toISOString() : null,
    dueAt: last ? new Date(dueAt).toISOString() : null,
    everyHours,
  }
  // Never run before: do it now rather than waiting an hour from a deploy.
  if (last && now < dueAt) return { ran: false, reason: 'not-due', ...state }

  if (!(await takeLock(HOLD_MS))) return { ran: false, reason: 'busy', ...state }
  try {
    const result = await reclusterPool()
    // Stamped AFTER the work, so a run that dies part-way is retried on the next
    // tick instead of being counted as done.
    await setAppState(LAST_KEY, String(Date.now())).catch(() => {})
    return {
      ran: true,
      lastAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + everyHours * 3_600_000).toISOString(),
      everyHours,
      result,
    }
  } finally {
    await releaseLock()
  }
}

/** Where the hourly recluster stands, without moving it. */
export async function getReclusterState(
  everyHours: number = RECLUSTER_EVERY_HOURS
): Promise<{ lastAt: string | null; dueAt: string | null; everyHours: number }> {
  const raw = Number(await getAppState(LAST_KEY).catch(() => null))
  const last = Number.isFinite(raw) && raw > 0 ? raw : 0
  return {
    lastAt: last ? new Date(last).toISOString() : null,
    dueAt: last ? new Date(last + everyHours * 3_600_000).toISOString() : null,
    everyHours,
  }
}
