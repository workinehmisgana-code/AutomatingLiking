// Hourly harvest: pull new videos from the channels worth watching, and sort
// them without asking anyone.
//
// WHICH CHANNELS
// The ones whose links mostly SURVIVE: at least HARVEST_MIN_ACTIVE_PCT (50) per
// cent of everything we have ever held for that channel is still active rather
// than blocked. Channels below that line are left alone for a person to extract
// and filter by hand.
//
// An absolute bar, not a relative one. It used to be "the top half by rank
// score" — four percentiles blended — which always admits half the channels
// however bad they all are, and would keep harvesting from a channel whose
// every link had been blocked simply because the others were worse. Measured on
// the live pool: 1,138 of 5,448 channels clear 50%, and 3,993 sit at 0-9% —
// channels whose work has been thrown out almost in its entirety.
//
// rankChannels still decides the ORDER — it returns best-first — so the most
// promising of the eligible channels are visited first on each pass.
//
// WHAT HAPPENS TO WHAT IT FINDS
// Everything new is staged in verify_link first, exactly as the manual Extract
// button does. Then the titles are classified:
//
//   humanizer / AI-detector related  ->  merged straight into the pool
//   anything else, or NO TITLE       ->  left in the verify list for a person
//
// A missing title is deliberately NOT sent to the model. It would be guessing
// from an empty string, and the answer decides whether a link reaches real users
// without anyone seeing it. No title means a human looks.
//
// RESUMABLE
// One channel costs a listing fetch plus a detail fetch per new video, so a
// 60-second invocation covers a handful. The cursor into the ranked list is
// stored, and each run picks up where the last stopped and wraps around.

import { rankChannels } from './channelRank'
import { fetchChannelVideos, fetchVideoDetail } from './linkStats'
import { classifyRelated, type Item } from './titleClassify'
import { mergeVerifyLinks } from './verifyMerge'
import { loadVideosJson } from './videos'
import {
  saveVerifyLinks,
  getAllVerifyLinkUrls,
  getBlockedUrls,
  getAppState,
  setAppState,
} from './db'

/**
 * The share of a channel's links that must still be active for the automatic
 * harvest to take it. Below this, the channel is a person's job.
 *
 * "Active" is measured against every link we have ever held for the channel,
 * blocked ones included, even those long gone from the pool — a channel is not
 * rehabilitated by its bad links being deleted.
 */
export const HARVEST_MIN_ACTIVE_PCT = 50


/** Where the last run stopped, so the next one carries on. */
const CURSOR_KEY = 'channel_harvest_cursor'
/** The last run's summary, for the admin page and for "has this ever run?". */
const LAST_RUN_KEY = 'channel_harvest_last'

/** Channel listings fetched at once. */
const CHANNEL_CONCURRENCY = 4
/** Detail fetches per new video, within one channel. */
const DETAIL_CONCURRENCY = 4

export interface HarvestResult {
  /** Channels above the score threshold, in rank order. */
  eligible: number
  /** Channels actually looked at this run. */
  checked: number
  /** Videos we had never seen before. */
  found: number
  /** Of those, judged humanizer-related and merged into the pool. */
  merged: number
  /** Left in the verify list for a person: unrelated, or no title to judge. */
  staged: number
  /** Staged because there was no title at all. */
  untitled: number
  /** Channels whose listing came back empty. */
  failed: number
  /** Where the next run starts. */
  nextCursor: number
  /** True when this run wrapped past the end of the list. */
  wrapped: boolean
}

export interface LastRun extends HarvestResult {
  at: string
  ms: number
}

export async function getLastHarvest(): Promise<LastRun | null> {
  const raw = await getAppState(LAST_RUN_KEY).catch(() => null)
  if (!raw) return null
  try {
    return JSON.parse(raw) as LastRun
  } catch {
    return null
  }
}

/**
 * Run one slice of the harvest.
 *
 * `deadline` is an epoch-ms cutoff: no new channel is started past it, so the
 * caller always gets an answer inside its own time limit.
 */
export async function harvestOnce(deadline: number): Promise<HarvestResult> {
  const ranked = await rankChannels()
  // rankChannels returns best-first, so filtering keeps that order: the most
  // promising eligible channel is visited first on each pass.
  //
  // A null ratio means the channel has neither an active nor a blocked link —
  // nothing to judge it on — and it is excluded rather than assumed good.
  const eligible = ranked.filter(
    (c) => c.activePct !== null && c.activePct >= HARVEST_MIN_ACTIVE_PCT
  )

  const empty: HarvestResult = {
    eligible: eligible.length,
    checked: 0,
    found: 0,
    merged: 0,
    staged: 0,
    untitled: 0,
    failed: 0,
    nextCursor: 0,
    wrapped: false,
  }
  if (eligible.length === 0) return empty

  const cursorRaw = Number(await getAppState(CURSOR_KEY).catch(() => null))
  let cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? Math.floor(cursorRaw) : 0
  if (cursor >= eligible.length) cursor = 0

  // Everything we already know about, by video id. Matching on the numeric id
  // rather than the URL: the same video appears with and without query strings,
  // and as /video/ or /photo/.
  const [videos, staged, blocked] = await Promise.all([
    loadVideosJson().catch(() => []),
    getAllVerifyLinkUrls().catch(() => [] as string[]),
    getBlockedUrls().catch(() => [] as string[]),
  ])
  const known = new Set<string>()
  const add = (u: string) => {
    const m = u.match(/\/(?:video|photo)\/(\d+)/)
    if (m) known.add(m[1])
  }
  for (const v of videos) add(String((v as { url?: unknown }).url ?? ''))
  for (const u of staged) add(u)
  for (const u of blocked) add(u)

  const rows: Parameters<typeof saveVerifyLinks>[0] = []
  let checked = 0
  let failed = 0
  let next = cursor
  let wrapped = false

  const worker = async () => {
    for (;;) {
      if (Date.now() >= deadline) return
      const i = next++
      if (i >= eligible.length) return
      const handle = eligible[i].handle
      checked = Math.max(checked, i - cursor + 1)
      const listed = await fetchChannelVideos(handle)
      if (listed.length === 0) {
        failed++
        continue
      }
      const fresh = listed.filter((v) => !known.has(v.id))
      for (let k = 0; k < fresh.length; k += DETAIL_CONCURRENCY) {
        if (Date.now() >= deadline) return
        const chunk = fresh.slice(k, k + DETAIL_CONCURRENCY)
        const details = await Promise.all(chunk.map((v) => fetchVideoDetail(v.url)))
        details.forEach((d, n) => {
          const v = chunk[n]
          // Claim the id even on a detail failure, so two channels sharing a
          // repost cannot stage it twice in one pass.
          if (known.has(v.id)) return
          known.add(v.id)
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

  const reached = Math.min(next, eligible.length)
  let nextCursor = reached
  if (nextCursor >= eligible.length) {
    nextCursor = 0
    wrapped = true
  }

  if (rows.length === 0) {
    await setAppState(CURSOR_KEY, String(nextCursor)).catch(() => {})
    return { ...empty, checked: reached - cursor, failed, nextCursor, wrapped }
  }

  // Stage everything first, exactly as the manual button does, so a crash
  // between here and the merge leaves the links waiting rather than lost.
  await saveVerifyLinks(rows)

  // Only titled links can be judged. An untitled one goes to a person — asking
  // a model to classify an empty string and then merging on its answer would put
  // links in front of users that nobody ever read.
  const titled: Item[] = rows
    .filter((r) => String(r.title ?? '').trim())
    .map((r) => ({ url: String(r.url), title: String(r.title) }))
  const untitled = rows.length - titled.length

  let related: string[] = []
  if (titled.length > 0) {
    related = await classifyRelated(titled).catch(() => [] as string[])
  }

  let merged = 0
  if (related.length > 0) {
    const res = await mergeVerifyLinks({ urls: related }).catch(() => null)
    merged = res?.added ?? 0
  }

  await setAppState(CURSOR_KEY, String(nextCursor)).catch(() => {})

  return {
    eligible: eligible.length,
    checked: reached - cursor,
    found: rows.length,
    merged,
    staged: rows.length - merged,
    untitled,
    failed,
    nextCursor,
    wrapped,
  }
}

/** Run a slice and record what happened. */
export async function runHarvest(deadline: number): Promise<LastRun> {
  const t0 = Date.now()
  const r = await harvestOnce(deadline)
  const record: LastRun = { ...r, at: new Date().toISOString(), ms: Date.now() - t0 }
  await setAppState(LAST_RUN_KEY, JSON.stringify(record)).catch(() => {})
  return record
}
