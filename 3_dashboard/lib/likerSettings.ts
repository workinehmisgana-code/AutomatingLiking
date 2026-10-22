import { isGenre } from '@/lib/config'
/**
 * What the phone's comment liker should do, set here rather than on the phone.
 *
 * THE NUMBERS LIVE IN ONE PLACE ON PURPOSE. The heart rules exist twice — in
 * `2_comment_automation/automate.py` for a run on a PC, and in the Android app
 * for a run on the handset — because Playwright cannot run on Android and a
 * WebView cannot run Python. Two implementations of the same rules drift, and
 * the thing they drift on is how many hearts land on a stranger's video.
 *
 * Keeping the VALUES here means at least the two cannot disagree about the
 * ceiling, the floor or the margin: both read these. The arithmetic still has
 * to be mirrored, and `check_to_top.py` on one side and `LikerRulesTest` on the
 * other are what keep it honest.
 */
import { getAppState, setAppState } from './db'

export type LikerClusterBy = 'rank' | 'date' | 'combined'

export type LikerSettings = {
  /** Off means the phone stops asking for work; the app shows why. */
  enabled: boolean
  clusterBy: LikerClusterBy
  /** "all", or a list like "1,2". Matches the admin Links page. */
  clusters: string
  platform: string
  /**
   * Which genre's links to work, or '' for every genre.
   *
   * IT IS NOT A COSMETIC FILTER. The liker hearts OUR comment on a video, and
   * which comment is ours depends on the genre: a cocodly link carries cocodly
   * comments and nothing else. Left at '' the phone is handed a mixed list and
   * the keyword set has to cover every product at once, which works but means
   * a run cannot be aimed at one product's videos.
   */
  genre: string
  category: string
  /** How many links to hand the phone in one go. */
  maxLinks: number
  /** Comma-separated. Blank means the products the dashboard has switched on. */
  keywords: string
  /** Aim at the best other comment rather than a share of the video's likes. */
  toTop: boolean
  /** How far past the best other comment to land. */
  margin: number
  /** Heart batches per video per visit. */
  rounds: number
  /** Seconds spent reading the real heart count back after a batch. */
  watch: number
  /** The least a comment may carry, as a share of the video's likes. */
  floor: number
  /** The most it may carry, as a share of the video's likes. */
  threshold: number
  /** Links the phone skips because another runner is on them. */
  share: boolean
}

export const LIKER_DEFAULTS: LikerSettings = {
  enabled: false,
  // COMBINED, NOT RANK. Rank clustering is also a filter: it keeps only links
  // that carry a search rank, about 1.5% of the pool, because everything
  // scraped from a channel is date-only. The PC liker and the Zefoy runner had
  // the same default and both found nothing with a genre picked.
  clusterBy: 'combined',
  clusters: 'all',
  platform: 'tiktok',
  // Every genre, which is how it behaved before genres existed.
  genre: '',
  category: '',
  maxLinks: 300,
  keywords: '',
  toTop: true,
  margin: 3,
  rounds: 4,
  watch: 45,
  floor: 0.25,
  threshold: 0.85,
  share: true,
}

const KEY = 'liker_settings'

const clamp = (n: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback

/**
 * Read whatever was stored and make it safe to act on.
 *
 * Every field is clamped rather than trusted. These numbers reach a phone that
 * will spend hearts with them, and a `floor` of 9 from a mistyped form would
 * mean "carry nine times the video's likes" — the kind of value that is
 * obviously wrong here and invisible on the handset.
 */
export function parseLikerSettings(raw: unknown): LikerSettings {
  const o = (raw ?? {}) as Record<string, unknown>
  const d = LIKER_DEFAULTS
  const num = (v: unknown, fb: number) => (typeof v === 'number' ? v : Number(v ?? NaN)) || fb
  const by = String(o.clusterBy ?? d.clusterBy)
  const threshold = clamp(num(o.threshold, d.threshold), 0.05, 1, d.threshold)
  // The floor can never reach the ceiling: a comment cannot be required to
  // carry more than it is allowed to.
  const floor = clamp(num(o.floor, d.floor), 0, Math.max(0, threshold - 0.05), d.floor)
  return {
    enabled: Boolean(o.enabled ?? d.enabled),
    clusterBy: (['rank', 'date', 'combined'].includes(by) ? by : d.clusterBy) as LikerClusterBy,
    clusters: String(o.clusters ?? d.clusters).trim() || d.clusters,
    platform: String(o.platform ?? d.platform).trim() || d.platform,
    // '' is a REAL value here - it means every genre - so an unrecognised one
    // falls back to that rather than silently narrowing a run to one pool.
    genre: isGenre(o.genre) ? o.genre : '',
    category: String(o.category ?? d.category).trim(),
    maxLinks: Math.round(clamp(num(o.maxLinks, d.maxLinks), 1, 5000, d.maxLinks)),
    keywords: String(o.keywords ?? d.keywords).trim(),
    toTop: Boolean(o.toTop ?? d.toTop),
    margin: Math.round(clamp(num(o.margin, d.margin), 1, 500, d.margin)),
    rounds: Math.round(clamp(num(o.rounds, d.rounds), 1, 20, d.rounds)),
    watch: Math.round(clamp(num(o.watch, d.watch), 0, 300, d.watch)),
    floor,
    threshold,
    share: Boolean(o.share ?? d.share),
  }
}

/** The settings as stored, with anything missing filled in from the defaults. */
export async function getLikerSettings(): Promise<LikerSettings> {
  const raw = await getAppState(KEY).catch(() => null)
  if (!raw) return { ...LIKER_DEFAULTS }
  try {
    return parseLikerSettings(JSON.parse(raw))
  } catch {
    return { ...LIKER_DEFAULTS }
  }
}

/** Store them, clamped. Returns what was actually written. */
export async function setLikerSettings(raw: unknown): Promise<LikerSettings> {
  const next = parseLikerSettings(raw)
  await setAppState(KEY, JSON.stringify(next))
  return next
}
