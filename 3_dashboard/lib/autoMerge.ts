// Automatic merge by channel spec.
//
// The Links-to-verify page judges links one of two ways: by title (the model's
// "is this related to the genre" verdict, which the hourly harvest uses to merge
// on its own) or by hand. This adds a third, for channels already trusted on
// their record: a SPEC — the same min/max filters the page's ranked-channel
// table offers — and every staged link of a channel that meets it is merged
// into the main links WITHOUT the related check. A channel whose links have
// stayed active, that posts often and gets hearts, has earned that.
//
// One spec per genre, because a channel's numbers are judged against its own
// genre's pool and the admin works one genre at a time.
//
// RUNS: on every hourly harvest slice (lib/channelHarvest.ts folds the matches
// into the merge it already makes, so the pool file is written once), and on
// demand from the page's "Run now".

import { getAppState, setAppState, pool } from './db'
import type { ChannelRow } from './channelRank'

/** [min, max]; null means no bound on that side. */
export type Bound = [number | null, number | null]

export interface AutoMergeSpec {
  enabled: boolean
  /** '' = every site. */
  platform: '' | 'tiktok' | 'instagram' | 'youtube'
  links: Bound
  hearts: Bound
  rate: Bound
  active: Bound
  last: Bound
  score: Bound
}

export const EMPTY_SPEC: AutoMergeSpec = {
  enabled: false,
  platform: '',
  links: [null, null],
  hearts: [null, null],
  rate: [null, null],
  active: [null, null],
  last: [null, null],
  score: [null, null],
}

const KEY = (genre: string) => `auto_merge_spec_${genre}`
const BOUNDS = ['links', 'hearts', 'rate', 'active', 'last', 'score'] as const

function num(v: unknown): number | null {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Any stored or posted shape into a valid spec. */
export function cleanSpec(v: unknown): AutoMergeSpec {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const out: AutoMergeSpec = { ...EMPTY_SPEC, enabled: o.enabled === true }
  const p = String(o.platform ?? '')
  out.platform = p === 'tiktok' || p === 'instagram' || p === 'youtube' ? p : ''
  for (const k of BOUNDS) {
    const b = Array.isArray(o[k]) ? (o[k] as unknown[]) : []
    out[k] = [num(b[0]), num(b[1])]
  }
  return out
}

/** A spec with no bound at all would merge every staged link of the genre. */
export function specHasBounds(s: AutoMergeSpec): boolean {
  return BOUNDS.some((k) => s[k][0] !== null || s[k][1] !== null)
}

export async function getAutoMergeSpec(genre: string): Promise<AutoMergeSpec> {
  const raw = await getAppState(KEY(genre)).catch(() => null)
  if (!raw) return { ...EMPTY_SPEC }
  try {
    return cleanSpec(JSON.parse(raw))
  } catch {
    return { ...EMPTY_SPEC }
  }
}

export async function saveAutoMergeSpec(genre: string, spec: AutoMergeSpec): Promise<AutoMergeSpec> {
  const clean = cleanSpec(spec)
  await setAppState(KEY(genre), JSON.stringify(clean))
  return clean
}

/**
 * Does a channel meet the spec? THE SAME RULE the page's filters apply: an
 * unknown value (no Active % for Instagram, a channel that posted once) fails
 * as soon as that bound is set — an unknown cannot be shown to be "at least 50".
 */
export function channelMeetsSpec(c: ChannelRow, s: AutoMergeSpec): boolean {
  if (s.platform && c.platform !== s.platform) return false
  const vals: Record<(typeof BOUNDS)[number], number | null> = {
    links: c.links,
    hearts: c.avgHearts,
    rate: c.perDay,
    active: c.activePct,
    last: c.lastPostDays,
    score: c.score,
  }
  for (const k of BOUNDS) {
    const [lo, hi] = s[k]
    if (lo === null && hi === null) continue
    const v = vals[k]
    if (v === null || !Number.isFinite(v)) return false
    if (lo !== null && v < lo) return false
    if (hi !== null && v > hi) return false
  }
  return true
}

/** The site a staged link is on, in the ranking's terms. */
function siteOfPlatform(p: string): string {
  return p.startsWith('youtube') ? 'youtube' : p
}

/**
 * Every STAGED link — new or waiting from before — whose channel meets its
 * genre's enabled spec. URLs only: the caller merges them, so a harvest can
 * fold them into the one merge it already makes.
 *
 * `ranked` is passed in when the caller has it (the harvest ranks anyway).
 * `onlyGenre` limits it to one genre, for the page's "Run now".
 */
export async function urlsMatchingSpecs(
  ranked: ChannelRow[],
  onlyGenre?: string,
  /** Count a switched-off spec too — the page's preview of turning it on. */
  opts: { ignoreEnabled?: boolean } = {}
): Promise<{ urls: string[]; channels: number; byGenre: Record<string, number> }> {
  const { rows: genres } = await pool.query<{ genre: string }>(
    `SELECT DISTINCT coalesce(genre, 'humanizer') AS genre FROM verify_link`
  )
  const urls: string[] = []
  const byGenre: Record<string, number> = {}
  let channels = 0
  for (const { genre } of genres) {
    if (onlyGenre && genre !== onlyGenre) continue
    const spec = await getAutoMergeSpec(genre)
    if ((!spec.enabled && !opts.ignoreEnabled) || !specHasBounds(spec)) continue
    // site:handle of every channel in this genre that meets the spec.
    const ok = new Set(
      ranked
        .filter((c) => c.genre === genre && channelMeetsSpec(c, spec))
        .map((c) => `${c.platform}:${c.handle.toLowerCase()}`)
    )
    if (ok.size === 0) continue
    const { rows } = await pool.query<{ url: string; account: string; platform: string }>(
      `SELECT url, lower(account) AS account, platform FROM verify_link
        WHERE coalesce(genre, 'humanizer') = $1 AND account IS NOT NULL AND account <> ''`,
      [genre]
    )
    const hit = new Set<string>()
    for (const r of rows) {
      const key = `${siteOfPlatform(r.platform)}:${r.account}`
      if (!ok.has(key)) continue
      urls.push(r.url)
      hit.add(key)
    }
    channels += hit.size
    if (hit.size) byGenre[genre] = rows.filter((r) => hit.has(`${siteOfPlatform(r.platform)}:${r.account}`)).length
  }
  return { urls, channels, byGenre }
}
