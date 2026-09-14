// The one lock that stops two jobs rewriting videos.json at the same time.
//
// Two things write the whole 38 MB pool: the six-hourly pipeline (a tick of it
// can be the recluster stage) and the hourly recluster. Run together, one write
// silently loses the other — the loser's rescore simply never happened, and
// nothing anywhere reports it.
//
// It lives in its own module rather than in pipeline.ts because the recluster
// needs it too, and importing it from there made the two files import each
// other. A cycle that happens to work today is not a thing to leave in place.

import { getAppState, setAppState } from './db'

const LOCK_KEY = 'pipeline_lock'

/** Default hold: longer than a pipeline tick's own budget, short enough that a
 *  crashed holder frees it within a couple of scheduler ticks. */
export const DEFAULT_LOCK_MS = 90_000

/**
 * Take the lock, or report who has it.
 *
 * Not a real mutex — two calls landing in the same millisecond could both think
 * they won. That is tolerable: the loser wastes a tick, which the next minute
 * replaces. What is not tolerable is a slow job still running when the next one
 * fires, and this stops that.
 *
 * `holdMs` lets a long job hold it for longer than a tick would.
 */
export async function takeLock(holdMs: number = DEFAULT_LOCK_MS): Promise<boolean> {
  const now = Date.now()
  const held = Number(await getAppState(LOCK_KEY).catch(() => null))
  if (Number.isFinite(held) && held > now) return false
  await setAppState(LOCK_KEY, String(now + holdMs)).catch(() => {})
  return true
}

export async function releaseLock(): Promise<void> {
  await setAppState(LOCK_KEY, '0').catch(() => {})
}
