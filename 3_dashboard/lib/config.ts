// ── Dashboard configuration (edit these in code) ─────────────────────────────

// Parse a boolean environment variable. Blank/unset → the given default;
// "false"/"0"/"no"/"off" → false; "true"/"1"/"yes"/"on" → true.
function envBool(v: string | undefined, dflt: boolean): boolean {
  if (v == null || v.trim() === '') return dflt
  const s = v.trim().toLowerCase()
  if (['false', '0', 'no', 'off'].includes(s)) return false
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  return dflt
}

// Whether the "Clicked today" row is shown to the user (both the web dashboard
// and the Android app's Details panel). Toggle with the SHOW_CLICKED_TODAY env
// var: set it to "false" (or 0/no/off) to hide it. Defaults to shown.
// NOTE: read only in server code (pages, route handlers) — client components
// receive it as a prop / via the app status API, never by importing it.
export const SHOW_CLICKED_TODAY = envBool(process.env.SHOW_CLICKED_TODAY, true)

// How many clusters to split the links into when grouping by search rank or
// posted date. Controlled here, NOT by the end user. Each dimension has its own
// count: search rank → RANK_CLUSTER_COUNT, posted date → DATE_CLUSTER_COUNT.
export const RANK_CLUSTER_COUNT = 30
export const DATE_CLUSTER_COUNT = 100
// Legacy single value (kept for generic references); prefer the per-dimension
// constants above.
export const CLUSTER_COUNT = 10

// The cluster count for a given grouping dimension.
export function clusterCountForDimension(dim: 'rank' | 'date' | 'combined'): number {
  return dim === 'date' ? DATE_CLUSTER_COUNT : RANK_CLUSTER_COUNT
}

// The rank/date split is no longer a clock. It used to be a repeating schedule
// of five-minute windows — rank for one, date for three — which made the mix a
// property of WHEN a user asked and handed everybody the same dimension at the
// same instant. It is now a probability per served link, set on the admin Links
// page and stored in app_kv; see lib/clusterMix.ts.

/**
 * Links the comment scan will read in one go.
 *
 * Reading a video's comments takes 1–5 seconds, so this is the only thing that
 * decides how long a scan runs — 4,000 links is several hours, and the whole
 * pool would be days.
 *
 * The limit used to be on CLUSTERS, which was a poor proxy: a cluster is a
 * relative slice, so "5 clusters" is ~900 links on one filter and tens of
 * thousands on another, and it blocked small deliberate selections that had no
 * clusters ticked at all. Counting the links counts the actual cost.
 *
 * Both the button and the route enforce this, from here, so they cannot
 * disagree.
 *
 * Lives in config rather than the route because a Next.js route file may only
 * export handlers and its own framework settings — exporting anything else fails
 * the production build with "not a valid Route export field".
 */
export const SCAN_MAX_LINKS = 4000

// ── Link audience categories ─────────────────────────────────────────────────
// Every link is sorted into ONE audience, from its caption and its channel's bio.
// The app then serves only the comments written for that audience, so a comment
// aimed at someone shopping for a rival humanizer never lands under a video
// about beating Turnitin.
//
//   competitors  the video promotes/reviews a RIVAL humanizer or paraphraser
//                (its viewers already want this kind of tool — win them over)
//   ai_detector  the video is about AI DETECTION — Turnitin, GPTZero, getting
//                flagged (its viewers have the problem our product solves)
//   generic      study/essay/AI content with no specific tool angle
export const LINK_CATEGORIES = ['competitors', 'ai_detector', 'generic'] as const
export type LinkCategory = (typeof LINK_CATEGORIES)[number]

export const DEFAULT_LINK_CATEGORY: LinkCategory = 'generic'

export function isLinkCategory(v: unknown): v is LinkCategory {
  return typeof v === 'string' && (LINK_CATEGORIES as readonly string[]).includes(v)
}

/** Human-readable label for the admin table. */
export const LINK_CATEGORY_LABEL: Record<LinkCategory, string> = {
  competitors: 'Competitors',
  ai_detector: 'AI detector',
  generic: 'Generic',
}

// ── Posted-date cluster scoring ──────────────────────────────────────────────
// The "posted date" dimension is not recency alone: each link gets a composite
// score and the clusters are cut from that. Weights must sum to 1.
//
//   recency  — how new the post is, as a percentile across the pool
//   isVideo  — 1 for a video, 0 for a photo/slideshow post
//   hearts   — THAT VIDEO'S own like/heart count, as a percentile across the
//              pool (not its channel's average)
export const DATE_WEIGHT_RECENCY = 0.3
export const DATE_WEIGHT_IS_VIDEO = 0.1
export const DATE_WEIGHT_HEARTS = 0.6

export interface DateWeights {
  recency: number
  isVideo: number
  hearts: number
}

/** The compiled-in defaults, used until an admin saves their own. */
export const DEFAULT_DATE_WEIGHTS: DateWeights = {
  recency: DATE_WEIGHT_RECENCY,
  isVideo: DATE_WEIGHT_IS_VIDEO,
  hearts: DATE_WEIGHT_HEARTS,
}

/**
 * Clean up admin-entered weights: drop anything not a finite number >= 0, then
 * RENORMALISE so the three sum to 1.
 *
 * Renormalising rather than rejecting lets the modal accept "30 / 10 / 60" as
 * readily as "0.3 / 0.1 / 0.6" — the scores only ever drive an ordering, so what
 * matters is the ratio between the weights, not their absolute size. An all-zero
 * (or unusable) set falls back to the defaults instead of producing NaN scores
 * that would silently flatten every cluster into one bucket.
 */
export function normalizeDateWeights(w: Partial<DateWeights> | null | undefined): DateWeights {
  const num = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  const recency = num(w?.recency)
  const isVideo = num(w?.isVideo)
  const hearts = num(w?.hearts)
  const total = recency + isVideo + hearts
  if (total <= 0) return { ...DEFAULT_DATE_WEIGHTS }
  const round = (n: number) => Math.round((n / total) * 10000) / 10000
  return { recency: round(recency), isVideo: round(isVideo), hearts: round(hearts) }
}

// How often (ms) the active platform tab auto-rotates (TikTok → YT Shorts →
// YT Videos → …), unless the user picks a tab manually.
export const PLATFORM_ROTATE_MS = 20 * 60 * 1000 // 20 minutes

// Number of a user's first clicks (after logging in) that show the
// "this link will be removed once opened" confirmation dialog.
export const REMINDER_CLICKS = 3

// Default / maximum retire quota: once a link has been clicked by this many
// DISTINCT users it is retired globally — removed from EVERY user's list. This
// is the CAP; lower-engagement TikTok/YouTube links retire earlier (see
// retireThreshold). A link clicked by this many distinct users is never shown again.
export const RETIRE_AFTER_USERS = 10

// Instagram links have no like/view count on the search grid, so they use a
// fixed quota rather than an engagement-based one.
export const INSTAGRAM_RETIRE_AFTER_USERS = 5

// TikTok/YouTube quota floor: the engagement-based quota is never below this.
export const RETIRE_MIN_TIKTOK_YT = 5

// Per-link retire quota, based on platform + engagement, in two tiers:
//   • up to RETIRE_AFTER_USERS (10): the normal divisor (÷5 TikTok, ÷50 YouTube),
//     floored at RETIRE_MIN_TIKTOK_YT (5).
//   • beyond 10: NOT capped — divide by 4× the divisor (÷20 TikTok, ÷200 YouTube)
//     so high-engagement links keep a larger quota (growing slowly), never below 10.
//   • Instagram : always INSTAGRAM_RETIRE_AFTER_USERS (5)
//   • other     : RETIRE_AFTER_USERS
// Zero/unknown engagement lands on the floor (5).
export function retireThreshold(platform: string, engagement: number): number {
  if (platform === 'instagram') return INSTAGRAM_RETIRE_AFTER_USERS
  const e = Number.isFinite(engagement) && engagement > 0 ? engagement : 0
  const tier = (div: number) => {
    const base = Math.floor(e / div)
    if (base <= RETIRE_AFTER_USERS) return Math.max(RETIRE_MIN_TIKTOK_YT, base)
    return Math.max(RETIRE_AFTER_USERS, Math.floor(e / (div * 4)))
  }
  if (platform === 'tiktok') return tier(5)
  if (platform === 'youtube_shorts' || platform === 'youtube_videos') return tier(50)
  return RETIRE_AFTER_USERS // other/unknown platforms
}

// Debug/admin accounts whose clicks must NOT count toward a link's retire quota
// (these accounts are used to test the system). Lowercased for comparison.
export const CLICK_EXCLUDED_EMAILS = [
  'kirubelman3@gmail.com',
  'misganaworkineh2011@gmail.com',
]

// Emails that see the admin dashboard (/admin) instead of the normal dashboard.
export const ADMIN_EMAILS = ['misganaworkineh2011@gmail.com']

// Compare two dotted version names numerically: >0 if a>b, <0 if a<b, 0 if equal.
// Non-numeric segments count as 0 ("1.10" > "1.9" > "1.1" > "1.0").
export function compareVersionNames(a: string, b: string): number {
  const pa = String(a || '').split('.')
  const pb = String(b || '').split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i] ?? '', 10) || 0
    const y = parseInt(pb[i] ?? '', 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// Is the app build (name/code it reports) NOT confirmed to be at least the latest
// published APK? STRICT: if a published APK exists but the app doesn't report a
// version we can compare against it, we can't confirm it's current, so we treat it
// as outdated (must update). Only when there is NO published APK at all — nothing
// to require — do we allow through.
export function isAppOutdated(
  appVersion: string | null | undefined,
  appCode: number | null | undefined,
  latestVersion: string | null | undefined,
  latestCode: number | null | undefined
): boolean {
  const lv = String(latestVersion || '').trim()
  const av = String(appVersion || '').trim()
  const hasLatestCode = typeof latestCode === 'number' && latestCode > 0
  const hasAppCode = typeof appCode === 'number' && appCode > 0

  // No published version to compare against → can't require an update.
  if (!hasLatestCode && !lv) return false

  // Best signal: compare versionCodes when both are present.
  if (hasLatestCode && hasAppCode) return appCode < latestCode
  // Otherwise compare dotted versionNames when both are present.
  if (lv && av) return compareVersionNames(av, lv) < 0

  // A published version exists but the app reported nothing we can compare
  // → cannot confirm it is current → require an update.
  return true
}

// Telegram handle a blocked user is told to contact (without the leading @).
// Override with NEXT_PUBLIC_ADMIN_TELEGRAM.
export const ADMIN_TELEGRAM = (process.env.NEXT_PUBLIC_ADMIN_TELEGRAM || 'YourAdminHandle').replace(/^@/, '')

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const e = email.toLowerCase()
  return ADMIN_EMAILS.some((a) => a.toLowerCase() === e)
}

// ── "Accounts you comment from" profile links ────────────────────────────────
// TikTok is required at onboarding; YouTube and Instagram are optional. Any link
// provided must be a valid URL for its platform.
export const PROFILE_LINKS = [
  { field: 'tiktok_url', label: 'TikTok', hosts: ['tiktok.com'], required: true },
  { field: 'youtube_url', label: 'YouTube', hosts: ['youtube.com', 'youtu.be'], required: false },
  { field: 'instagram_url', label: 'Instagram', hosts: ['instagram.com'], required: false },
] as const

// Validate one link. Returns an error string, or null if valid. An empty value is
// an error only when the link is required; optional empty links pass.
export function validateProfileLink(
  label: string,
  hosts: readonly string[],
  value: string,
  required = true
): string | null {
  const v = value.trim()
  if (!v) return required ? `Your ${label} profile link is required.` : null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
  } catch {
    return `Your ${label} link isn't a valid URL.`
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase()
  const ok = hosts.some((h) => host === h || host.endsWith(`.${h}`))
  if (!ok) return `Your ${label} link must be a ${label} URL (${hosts[0]}).`
  return null
}

// Validate the links. TikTok is required; YouTube/Instagram are optional but must
// be valid if provided. Returns the first error, or null if all valid.
export function validateAllProfileLinks(links: {
  tiktok_url?: string | null
  youtube_url?: string | null
  instagram_url?: string | null
}): string | null {
  for (const { field, label, hosts, required } of PROFILE_LINKS) {
    const err = validateProfileLink(label, hosts, String(links[field as keyof typeof links] ?? ''), required)
    if (err) return err
  }
  return null
}

// Platforms users report commented-video counts and screenshots for.
export const COMMENT_PLATFORMS = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram'] as const

// How many links one app fetch may return.
//
// The app keeps the whole batch in SharedPreferences and re-parses it on every
// interaction, so an uncapped feed (tens of thousands of links) makes the bubble
// sluggish on every tap. 1,000 is far more than a session can consume — the
// hourly quotas allow roughly 60 links an hour — so a capped batch is never the
// thing that runs out first.
export const APP_LINK_BATCH = Math.max(1, Number(process.env.APP_LINK_BATCH || 1000))

// ── Comment verification gate ────────────────────────────────────────────────
// Before anyone can work, they must prove they can actually post a comment from
// the TikTok account they registered. Everyone comments something harmless on
// ONE designated video; a checker reads that video's commenters and marks the
// matching users valid (see 5_comment_verifier). Until then they are held.
//
// Overridable without a redeploy so the video can be rotated.
export const VERIFY_VIDEO_URL =
  process.env.VERIFY_VIDEO_URL ||
  'https://www.tiktok.com/@drnardime/video/7596784835159444767'

// How long one successful check lasts before it must be re-done.
export const VERIFY_VALID_DAYS = Number(process.env.VERIFY_VALID_DAYS || 7)

// The gate is OFF by default and must be switched on deliberately with
// VERIFY_GATE_ENABLED=true. Defaulting to on would hold every user who has not
// been checked yet the moment this ships — which looks like a mass ban rather
// than a new step. Announce the video, run 5_comment_verifier/verify_gate.py
// until most users are verified, then turn it on.
export const VERIFY_GATE_ENABLED = envBool(process.env.VERIFY_GATE_ENABLED, false)

// Products a user can be assigned to advertise. The admin picks one per user,
// and the user's /comments page shows that product's comments.
export const PRODUCTS = [
  'purifytext',
  'acoustictext',
  'prohumanly',
  'humlexic',
  'kinprose',
  'tintfolio',
] as const
export type Product = (typeof PRODUCTS)[number]

/**
 * The product that opens a link we KNOW carries none of ours.
 *
 * Only the first comment. Once a link has one, every product is back in the
 * draw on equal terms — this decides who goes first on a clean video, not who
 * owns it.
 *
 * "Know" is meant strictly: the extraction must have read the video and found
 * none of ours. A link nobody has looked at does not count, because unexamined
 * and empty are not the same thing and most of the pool is the former.
 */
export const FIRST_ON_EMPTY_PRODUCT: Product = 'purifytext'

// How a product is WRITTEN inside a comment.
//
// Compound names are split into two words and every mention is wrapped in
// double quotes, so the brand reads as a name a person typed rather than as one
// keyword string. Nothing downstream breaks: every product matcher normalises
// by stripping non-alphanumerics before comparing (see norm() in commentScan,
// replyGen and linkCategory), so "\"purify text\"" still resolves to purifytext.
const PRODUCT_WORDS: Record<string, string> = {
  purifytext: 'purify text',
  acoustictext: 'acoustic text',
  prohumanly: 'pro humanly',
}

/** The product name as it should appear in a comment, without the quotes. */
export function productWords(product: string, split = true): string {
  return split ? PRODUCT_WORDS[product] ?? product : product
}

/**
 * The form used to FIND the brand in a model's output, always split.
 *
 * Matching and emitting are deliberately separate: whatever the admin has
 * chosen to write, the model may produce either spelling, and a matcher built
 * from the unsplit form would miss "purify text" entirely.
 */
export function productMatchWords(product: string): string {
  return PRODUCT_WORDS[product] ?? product
}

/** How a brand mention is written, per the product's own settings. */
export interface CommentStyle {
  /** End each comment with an upbeat emoji. */
  emoji: boolean
  /** Write compound names as two words: purifytext -> purify text. */
  splitBrand: boolean
  /** Wrap the name in double quotes. */
  quoteBrand: boolean
}

export const DEFAULT_COMMENT_STYLE: CommentStyle = {
  emoji: true,
  splitBrand: true,
  quoteBrand: true,
}

/** The brand exactly as it should appear in a comment, under these settings. */
export function productMention(product: string, style: CommentStyle = DEFAULT_COMMENT_STYLE): string {
  const words = productWords(product, style.splitBrand)
  return style.quoteBrand ? '"' + words + '"' : words
}

export function isProduct(v: unknown): v is Product {
  return typeof v === 'string' && (PRODUCTS as readonly string[]).includes(v)
}

// Products that are temporarily unavailable — shown disabled in the admin
// dropdown and not assignable, and left out of the app's comment pool. Add a
// product here to switch it off; remove it to re-enable. Currently none are off:
// every product in PRODUCTS is live.
export const DEACTIVATED_PRODUCTS: readonly Product[] = []

// Payment (birr) a user earns per approved 30s–1min video they submit.
export const VIDEO_PAYMENT_BIRR = 150

// Birr paid per comment a user makes. Total owed for comments =
// (total comments since last reset) × COMMENT_PAY_RATE.
export const COMMENT_PAY_RATE = 0.5

// How often the click-to-copy comments are re-shuffled (order only) so users
// see a different arrangement. Order is stable within the window and changes
// each window — driven by an hour bucket, so no backend timer is needed.
export const COMMENT_SHUFFLE_MS = 60 * 60 * 1000 // 1 hour

// ── Promo videos (admin uploads, users repost) ───────────────────────────────
// A separate task from the "create your own video" (VIDEO_PAYMENT_BIRR) one.
// The admin uploads videos + a pool of titles + shared tags; users download a
// video, repost it to their own dedicated account on each platform, then submit
// the link. Each submitted link earns PROMO_PAY_BIRR.
export const PROMO_PLATFORMS = [
  { key: 'tiktok', label: 'TikTok' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'instagram', label: 'Instagram' },
] as const
export type PromoPlatform = (typeof PROMO_PLATFORMS)[number]['key']

export function isPromoPlatform(v: unknown): v is PromoPlatform {
  return typeof v === 'string' && PROMO_PLATFORMS.some((p) => p.key === v)
}

// Birr earned per platform link submitted (one repost on one dedicated account).
export const PROMO_PAY_BIRR = 15
// A user may submit at most this many links per platform per day (1 upload per
// dedicated account per day).
export const PROMO_DAILY_LIMIT_PER_PLATFORM = 1
// A user may download at most this many videos per day. Once used up, further
// (not-yet-downloaded) videos are locked with a countdown to the next day.
export const PROMO_DOWNLOAD_DAILY_LIMIT = 1

// Tags every promo caption MUST include, appended after the product-name tag.
// Groq adds more relevant tags on top of these; users may add even more.
export const PROMO_MANDATORY_TAGS = [
  '#humanizer',
  '#aitools',
  '#writingtool',
  '#AIdetector',
  '#fyp',
] as const

// Build the required tag line: product name first, then the mandatory tags.
export function mandatoryPromoTags(product: string | null): string {
  const first = product ? `#${product.replace(/[^a-z0-9]/gi, '')}` : ''
  return [first, ...PROMO_MANDATORY_TAGS].filter(Boolean).join(' ')
}

// How many AI-generated caption titles to show, and how often to refresh them.
export const PROMO_TITLE_COUNT = 12
export const PROMO_REFRESH_MS = 24 * 60 * 60 * 1000 // regenerate titles/tags every 24h
// The AI may add at most this many extra tags on top of the mandatory ones.
export const PROMO_EXTRA_TAG_MAX = 3

// A user may open at most HOURLY_LINK_LIMIT links per platform within any
// rolling HOURLY_WINDOW_MS. When a platform hits the cap it's locked until the
// window frees up, and the UI switches to another platform that still has quota.
// These are the DEFAULTS — the admin can override the quota + wait window per
// platform in the admin dashboard (stored in the platform_limit DB table).
export const HOURLY_LINK_LIMIT = 20
export const HOURLY_WINDOW_MS = 60 * 60 * 1000 // 1 hour

// The link platforms whose quota + wait window are individually configurable.
export const CLICK_PLATFORMS = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram'] as const
export type ClickPlatform = (typeof CLICK_PLATFORMS)[number]

export const CLICK_PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  youtube_shorts: 'YT Shorts',
  youtube_videos: 'YT Videos',
  instagram: 'Instagram',
}

// One platform's rule. TWO independent per-platform switches:
//   • `enabled`       — the HOURLY quota: `limit` links per rolling `windowMs`
//                       (`limit <= 0` means unlimited / never locked). Applies on
//                       its own, whatever the master switch says.
//   • `retireEnabled` — LINK RETIREMENT for this platform (a link leaving the pool
//                       once enough distinct users have clicked it). Applies only
//                       when the MASTER switch and this flag are both on.
export interface PlatformLimit {
  limit: number
  windowMs: number
  enabled: boolean
  retireEnabled: boolean
}

// Default rule for every platform (used until the admin overrides it). Both
// switches default on, so behaviour only changes where the admin explicitly
// switches something off.
export const DEFAULT_PLATFORM_LIMIT: PlatformLimit = {
  limit: HOURLY_LINK_LIMIT,
  windowMs: HOURLY_WINDOW_MS,
  enabled: true,
  retireEnabled: true,
}

// ── AI comment rewriting (Groq) ──────────────────────────────────────────────
// The click-to-copy comments on /comments are periodically rewritten by an LLM
// into fresh, very short variants that keep the same theme but always mention
// the product. The originals in lib/comments.ts act as the theme source.
export const COMMENT_REFRESH_MS = 24 * 60 * 60 * 1000 // regenerate every 24 hours
export const GROQ_MODEL = 'openai/gpt-oss-120b'
// Models tried in order; on a rate-limit/quota error (HTTP 429) the request
// automatically falls back to the next one.
export const GROQ_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'qwen/qwen3.6-27b']
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
// Rewrites must be this many words (inclusive) and mention the product name.
export const COMMENT_WORD_MIN = 3
export const COMMENT_WORD_MAX = 8
