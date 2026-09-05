// The automatic cycle, once every CYCLE_HOURS (6):
//
//   idle -> harvest -> extract comments -> categorise -> recluster -> idle
//
// Look for new videos on the channels worth watching, then do the work that
// integrates whatever turned up: read the comments on the clusters that matter,
// sort the new links into an audience, and rescore the pool so they land in the
// right clusters. Then wait for the next six-hour mark.
//
// WHY A STATE MACHINE AND NOT A SCRIPT
// A serverless invocation gets a minute. One lap of this needs hours: reading a
// video's comments takes seconds, and the extract stage alone covers every
// rank-clustered link plus the top three posted-date clusters — measured at
// 7,375 links, about 2.3 hours of continuous reading. So each tick does a slice
// of the CURRENT stage and stops; when a stage reports itself finished the
// pointer moves on, and after recluster it returns to the start.
//
// TICKS ARE NOT THE CYCLE
// vercel.json fires this EVERY MINUTE, and that is not the same as the cycle
// running every minute. A tick is at most ~45 seconds of work, so the tick rate
// is simply how fast the cycle can move once it has started: at one tick an hour
// the work would take over a week, and at one a minute it takes about three
// hours. Between cycles almost every tick reads one row, sees the six hours are
// not up, and stops.
//
// Every stage is resumable on its own terms:
//   harvest    a cursor through the ranked channels
//   extract    a cursor through the target links
//   categorise no cursor needed — it only ever looks at UNcategorised links, so
//              finishing some removes them from the set
//   recluster  one pass over the pool, done in a single tick

import {
  getAppState,
  setAppState,
  getScannedUrls,
  saveLinkScan,
  startPipelineCycle,
  recordPipelineStage,
  finishPipelineCycle,
  savePipelineScans,
  prunePipelineScans,
} from './db'
import { runHarvest } from './channelHarvest'
import { buildAdminLinks } from './adminLinks'
import { scanLink } from './commentScan'
import { categorizeSome } from './categorise'
import { reclusterPool } from './recluster'

export const STAGES = ['idle', 'harvest', 'extract', 'categorise', 'recluster'] as const
export type Stage = (typeof STAGES)[number]

/** How often a new cycle begins. */
export const CYCLE_HOURS = 6

const STAGE_KEY = 'pipeline_stage'
/** When the current (or last) cycle started, so idle knows when to wake. */
const CYCLE_STARTED_KEY = 'pipeline_cycle_started'
/** The pipeline_cycle row the current cycle is folding its totals into. */
const CYCLE_ID_KEY = 'pipeline_cycle_id'
/** Held while a tick is running, so two never work the same cursor at once. */
const LOCK_KEY = 'pipeline_lock'
const EXTRACT_CURSOR_KEY = 'pipeline_extract_cursor'
const LAST_KEY = 'pipeline_last'

/**
 * How long a tick may hold the lock before another may take over.
 *
 * Ticks fire every minute and one can run for 45 seconds, so two would overlap
 * on any hiccup — and two ticks on the same cursor would scan the same links
 * twice and then skip a stretch, because each writes back its own idea of where
 * it got to. The lease is generous enough to cover a slow tick and short enough
 * that a crashed one does not stall the cycle for long.
 */
const LOCK_MS = 90_000

/** Comment reads in flight. Matches the manual scan; TikTok throttles above it. */
const SCAN_CONCURRENCY = 4
/** Posted-date clusters to extract, counting from the best. */
const DATE_CLUSTERS = 3

export interface TickResult {
  stage: Stage
  /** The stage after this tick — different when the stage finished. */
  nextStage: Stage
  done: boolean
  detail: Record<string, unknown>
  ms: number
  at: string
}

export async function getStage(): Promise<Stage> {
  const raw = await getAppState(STAGE_KEY).catch(() => null)
  // Default to idle rather than harvest: a fresh install should wait for its
  // first scheduled cycle, not start one because nothing has been recorded yet.
  return (STAGES as readonly string[]).includes(raw ?? '') ? (raw as Stage) : 'idle'
}

/** When the current or last cycle began, and when the next one is due. */
export async function getCycleTiming(): Promise<{ startedAt: string | null; dueAt: string | null }> {
  const raw = Number(await getAppState(CYCLE_STARTED_KEY).catch(() => null))
  if (!Number.isFinite(raw) || raw <= 0) return { startedAt: null, dueAt: null }
  return {
    startedAt: new Date(raw).toISOString(),
    dueAt: new Date(raw + CYCLE_HOURS * 3_600_000).toISOString(),
  }
}

export async function getLastTick(): Promise<TickResult | null> {
  const raw = await getAppState(LAST_KEY).catch(() => null)
  if (!raw) return null
  try {
    return JSON.parse(raw) as TickResult
  } catch {
    return null
  }
}

/**
 * The links the extract stage covers: EVERY search-rank cluster, plus the top
 * `DATE_CLUSTERS` posted-date clusters.
 *
 * Cluster membership is assigned by buildAdminLinks, so this asks the same code
 * the Links page does rather than re-deriving it — clusters are relative, and a
 * second derivation would drift from what is on screen.
 */
interface Target {
  url: string
  /** The cluster this link was in AT SCAN TIME. Clusters are relative and move
   *  with the pool, so the report stores them rather than reading them back. */
  rankCluster: number | null
  dateCluster: number | null
}

async function extractTargets(): Promise<Target[]> {
  const { rows } = await buildAdminLinks('')
  const out = rows
    .filter((l) => !l.blocked)
    .filter((l) => /tiktok\.com\/@[^/]+\/(?:video|photo)\/\d+/i.test(l.url))
    .filter((l) => l.rankCluster > 0 || (l.dateCluster > 0 && l.dateCluster <= DATE_CLUSTERS))
    .map((l) => ({
      url: l.url,
      rankCluster: l.rankCluster > 0 ? l.rankCluster : null,
      // Only the clusters this stage actually covers, so the report never shows
      // a date cluster it was never asked to read.
      dateCluster: l.dateCluster > 0 && l.dateCluster <= DATE_CLUSTERS ? l.dateCluster : null,
    }))
  out.sort((a, b) => a.url.localeCompare(b.url))
  return out
}

/** Read comments for the next slice of the target set. */
async function extractTick(
  deadline: number,
  cycleId: number
): Promise<{ done: boolean; detail: Record<string, unknown> }> {
  const urls = await extractTargets()
  if (urls.length === 0) return { done: true, detail: { targets: 0 } }

  const raw = Number(await getAppState(EXTRACT_CURSOR_KEY).catch(() => null))
  let cursor = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  if (cursor >= urls.length) cursor = 0

  // A pass ends when the cursor reaches the end, and the next one starts over
  // and re-reads everything. That is deliberate — the whole point is to notice
  // comments appearing over time.
  const slice = urls.slice(cursor, cursor + 60)
  const alreadyDone = await getScannedUrls(slice.map((t) => t.url)).catch(() => new Set<string>())

  let read = 0
  let withOurs = 0
  let next = 0
  const queue = slice
  // Kept per link so the report can compare this cycle against the last one:
  // totals cannot answer "of the links that lacked ours, how many gained one".
  const seen: Parameters<typeof savePipelineScans>[1] = []
  const worker = async () => {
    for (;;) {
      if (read > 0 && Date.now() >= deadline) return
      const i = next++
      if (i >= queue.length) return
      const target = queue[i]
      const url = target.url
      const r = await scanLink(url)
      read++
      if (r.unresolved) continue
      seen.push({
        url: r.url,
        ourCount: r.ourCount,
        readCount: r.readCount,
        rankCluster: target.rankCluster,
        dateCluster: target.dateCluster,
      })
      await saveLinkScan({
        url: r.url,
        readCount: r.readCount,
        totalCount: r.totalCount,
        complete: r.complete,
        ourCount: r.ourCount,
        bestRank: r.bestRank,
        topText: r.top?.text ?? null,
        topUser: r.top?.username ?? null,
        topLikes: r.top?.likes ?? null,
        hits: r.hits,
      }).catch(() => {})
      if (r.ourCount > 0) withOurs++
    }
  }
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker))
  if (cycleId > 0) await savePipelineScans(cycleId, seen).catch(() => {})

  const advanced = Math.min(next, queue.length)
  const nextCursor = cursor + advanced
  const finished = nextCursor >= urls.length
  await setAppState(EXTRACT_CURSOR_KEY, String(finished ? 0 : nextCursor)).catch(() => {})

  return {
    done: finished,
    detail: {
      targets: urls.length,
      from: cursor,
      read,
      withOurs,
      alreadyScanned: alreadyDone.size,
      progress: `${Math.min(nextCursor, urls.length)}/${urls.length}`,
    },
  }
}

/**
 * Take the lock, or report who has it.
 *
 * Not a real mutex — two calls landing in the same millisecond could both think
 * they won. That is tolerable here: the loser wastes a tick, which the next
 * minute replaces. Losing a cursor to two concurrent writers is not tolerable,
 * and this stops the common case of a slow tick still running when the next
 * fires.
 */
async function takeLock(): Promise<boolean> {
  const now = Date.now()
  const held = Number(await getAppState(LOCK_KEY).catch(() => null))
  if (Number.isFinite(held) && held > now) return false
  await setAppState(LOCK_KEY, String(now + LOCK_MS)).catch(() => {})
  return true
}

async function releaseLock(): Promise<void> {
  await setAppState(LOCK_KEY, '0').catch(() => {})
}

/** Run one slice of whatever stage the cycle is on. */
export async function tick(deadline: number): Promise<TickResult> {
  const t0 = Date.now()
  const stage = await getStage()
  if (!(await takeLock())) {
    return {
      stage,
      nextStage: stage,
      done: false,
      detail: { skipped: 'another tick is still running' },
      ms: Date.now() - t0,
      at: new Date().toISOString(),
    }
  }
  try {
    return await runStage(stage, deadline, t0)
  } finally {
    await releaseLock()
  }
}

async function runStage(stage: Stage, deadline: number, t0: number): Promise<TickResult> {
  let done = false
  let detail: Record<string, unknown> = {}

  if (stage === 'idle') {
    // Waiting for the next cycle. The ticks keep arriving every minute — that is
    // what lets a cycle, once started, get through hours of work in an afternoon
    // — but between cycles they cost one small read and nothing else.
    const raw = Number(await getAppState(CYCLE_STARTED_KEY).catch(() => null))
    const last = Number.isFinite(raw) && raw > 0 ? raw : 0
    const dueAt = last + CYCLE_HOURS * 3_600_000
    const now = Date.now()
    // Never started: begin one now, so a fresh deploy does not sit idle for six
    // hours before doing anything.
    done = last === 0 || now >= dueAt
    if (done) {
      await setAppState(CYCLE_STARTED_KEY, String(now)).catch(() => {})
      // A row per cycle, opened here and closed after recluster. Every stage in
      // between folds its numbers into it.
      const id = await startPipelineCycle().catch(() => 0)
      await setAppState(CYCLE_ID_KEY, String(id)).catch(() => {})
    }
    detail = done
      ? { starting: true, every: `${CYCLE_HOURS}h` }
      : {
          waiting: true,
          dueAt: new Date(dueAt).toISOString(),
          minutesLeft: Math.max(0, Math.round((dueAt - now) / 60000)),
        }
  } else if (stage === 'harvest') {
    const r = await runHarvest(deadline)
    detail = { ...r }
    // A harvest lap ends when its channel cursor wraps back to the top.
    done = r.wrapped || r.eligible === 0
  } else if (stage === 'extract') {
    const cycleId = Number(await getAppState(CYCLE_ID_KEY).catch(() => null))
    const r = await extractTick(deadline, Number.isFinite(cycleId) ? cycleId : 0)
    done = r.done
    detail = r.detail
  } else if (stage === 'categorise') {
    const r = await categorizeSome(deadline)
    done = r.done
    detail = { ...r }
  } else {
    const r = await reclusterPool()
    done = true
    detail = { ...r }
  }

  // Keep the numbers. Counts ADD across ticks — a stage can take a hundred of
  // them, and the last tick's slice is not the stage's total.
  if (stage !== 'idle') {
    const id = Number(await getAppState(CYCLE_ID_KEY).catch(() => null))
    if (Number.isFinite(id) && id > 0) {
      const ADD: Record<string, string[]> = {
        harvest: ['checked', 'found', 'merged', 'staged', 'untitled', 'failed'],
        extract: ['read', 'withOurs'],
        categorise: ['processed', 'saved'],
        recluster: [],
      }
      await recordPipelineStage(id, stage, detail, ADD[stage] ?? []).catch(() => {})
      if (done && stage === 'recluster') {
        await finishPipelineCycle(id).catch(() => {})
        // ~7,000 rows a cycle, four cycles a day. Keeping the last eight is two
        // days of history, which is all the report compares.
        await prunePipelineScans(8).catch(() => {})
      }
    }
  }

  const nextStage = done ? STAGES[(STAGES.indexOf(stage) + 1) % STAGES.length] : stage
  if (nextStage !== stage) await setAppState(STAGE_KEY, nextStage).catch(() => {})

  const out: TickResult = {
    stage,
    nextStage,
    done,
    detail,
    ms: Date.now() - t0,
    at: new Date().toISOString(),
  }
  await setAppState(LAST_KEY, JSON.stringify(out)).catch(() => {})
  return out
}
