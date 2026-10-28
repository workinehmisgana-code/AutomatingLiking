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

// Show the tasks OTHER than links — the video task, Repost & earn and the email
// task — on the user dashboard and the guide. Env var SHOW_OTHER_TASKS: set it
// to "false" (or 0/no/off) and workers see links only; the three task pages send
// them back to their links. Defaults to shown. Pay already earned on those tasks
// still shows under pending pay. Server code only, like SHOW_CLICKED_TODAY.
export const SHOW_OTHER_TASKS = envBool(process.env.SHOW_OTHER_TASKS, true)

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

/**
 * The audience whose comments are served for a link that HAS NO CATEGORY —
 * never classified, or classified into something no longer recognised.
 *
 * Not the same decision as DEFAULT_LINK_CATEGORY above, which is what the
 * CLASSIFIER writes down when it cannot tell. This one is what the SERVER reads
 * when nothing was written down at all, and the two want opposite things: a
 * label should admit it knows nothing ('generic'), while a comment still has to
 * be worth pasting. 'competitors' is the safer guess by a distance — it is where
 * three quarters of the classified pool ended up, and its comments assume only
 * that the viewer is shopping for a tool like ours, which is true of almost any
 * video we scraped from these keywords.
 */
export const FALLBACK_COMMENT_CATEGORY: LinkCategory = 'competitors'

/**
 * The audience to serve for a link of this genre that has no category.
 *
 * 'competitors' is the right guess for a humanizer link, for the reasons above:
 * three quarters of the classified pool landed there and its comments assume
 * only that the viewer is shopping for a tool like ours.
 *
 * THE OTHER GENRES START ON 'generic', and the classifier is not run on them at
 * all. The three audiences were drawn for humanizers — 'ai_detector' means
 * nothing to a slide maker — and their links all arrive from genre-specific
 * searches anyway, so splitting them by audience buys very little on day one.
 * When it does, this is the function to change and the categoriser is the other.
 */
export function fallbackCategory(genre: string): LinkCategory {
  return genre === DEFAULT_GENRE ? FALLBACK_COMMENT_CATEGORY : 'generic'
}

/**
 * The audiences a genre's comments are written for.
 *
 * Three for humanizers, one for the rest — the same reasoning as
 * fallbackCategory: the classifier is not run on those genres, so every link in
 * them is 'generic' and a set written for 'ai_detector' would never be served.
 *
 * Used by the admin page, so it shows one panel instead of three empty ones, and
 * by the regeneration so it does not spend an LLM call per audience per product
 * writing comments nothing will ask for.
 */
export function audiencesForGenre(genre: string): readonly LinkCategory[] {
  return genre === DEFAULT_GENRE ? LINK_CATEGORIES : (['generic'] as const)
}

/** The audiences one product's comments are written for. */
export function audiencesForProduct(product: string): readonly LinkCategory[] {
  return audiencesForGenre(genreOfProduct(product))
}

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

/**
 * TEST ACCOUNTS: the owner's own accounts, used to try the app as a worker.
 *
 * Never restricted by the machinery that protects the pool from workers: not
 * auto-blocked by comment checks, not held by the TikTok account-age gate, and
 * not stopped by the hourly link limits. Everything else (pay, records, the
 * screens) behaves exactly as for anyone, which is the point of testing with
 * them. Extend with TEST_EMAILS (comma-separated).
 */
const TEST_EMAILS = [
  'kirubelman3@gmail.com',
  ...String(process.env.TEST_EMAILS ?? '').split(','),
]
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

export function isTestEmail(email: string | null | undefined): boolean {
  return !!email && TEST_EMAILS.includes(email.trim().toLowerCase())
}

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

// ── The TikTok profile link, exactly ────────────────────────────────────
//
// IT HAS TO BE THE @USERNAME FORM: https://www.tiktok.com/@username.
//
// A host check is not enough, and that is not a tidiness preference. Everything
// downstream reads the @username straight out of this string — the verification
// gate looks for that handle in a video's commenters, the comment-presence scan
// judges a user's work by it, and `handleFromProfile` in lib/commentPresence.ts
// is a single `/@([^/?#\s]+)/`. A link with no @ in it returns null there, so the
// person can never be verified and their work can never be credited: they sit at
// the gate forever with nothing visibly wrong.
//
// So these are all rejected, each for a reason that cannot be worked around:
//
//   tiktok.com/username            no @ — not a handle we can look for
//   tiktok.com/@user/video/123     a video, not the account that posted it
//   vm.tiktok.com/ZMabc123         a short link; the username is behind a
//                                  redirect and is not in the text at all
//   tiktok.com/t/ZTabc123          the same, in TikTok's other share form
//
// What IS accepted is the same link written casually: no https://, no www., a
// trailing slash, TikTok's own `?_t=…&_r=1` share parameters, or odd case.
// Those name the right account unambiguously, so they are tidied rather than
// bounced — refusing somebody over a trailing slash is a support message, not a
// data problem.
export const TIKTOK_PROFILE_EXAMPLE = 'https://www.tiktok.com/@username'

// TikTok's own rule for a username: letters, digits, underscores and periods.
const TIKTOK_HANDLE_RE = /^[a-zA-Z0-9._]{2,24}$/

/**
 * The canonical form of a TikTok profile link, or null if it is not one.
 *
 * Returns both, because callers need both: `url` is what gets stored so every
 * row looks the same, and `handle` (lowercased) is what the verifier and the
 * presence scan actually search for.
 */
export function canonicalTiktokProfile(
  raw: string | null | undefined
): { url: string; handle: string } | null {
  const v = String(raw ?? '').trim()
  if (!v) return null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase()
  if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return null
  // One path segment and it must be the handle. Two or more is a video, a photo
  // or a /t/ share link; none at all is tiktok.com itself.
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 1) return null
  const first = decodeURIComponent(parts[0])
  if (!first.startsWith('@')) return null
  const handle = first.slice(1)
  if (!TIKTOK_HANDLE_RE.test(handle)) return null
  // The handle keeps the case it was typed in — it is what the person sees on
  // their own profile. Matching is done on the lowercased copy.
  return { url: `https://www.tiktok.com/@${handle}`, handle: handle.toLowerCase() }
}

/** True when a stored link is not in the @username form (and is not empty). */
export function isTiktokProfileMisformatted(raw: string | null | undefined): boolean {
  const v = String(raw ?? '').trim()
  return v.length > 0 && canonicalTiktokProfile(v) === null
}

/**
 * The error a person sees. One error string, in their words, saying what to
 * paste — a message that only says "invalid" sends them to ask somebody.
 */
export function validateTiktokProfile(value: string | null | undefined): string | null {
  const v = String(value ?? '').trim()
  if (!v) return 'Your TikTok profile link is required.'
  if (canonicalTiktokProfile(v)) return null
  return (
    'That is not a TikTok profile link. It has to be your own profile, in this form: ' +
    `${TIKTOK_PROFILE_EXAMPLE} — open your profile in the TikTok app, tap the arrow or ` +
    'the three dots, choose "Copy link", and paste it here. A link to one of your ' +
    'videos, a vm.tiktok.com short link, or a link without the @ in it cannot be used.'
  )
}

// Validate the links. TikTok is required; YouTube/Instagram are optional but must
// be valid if provided. Returns the first error, or null if all valid.
export function validateAllProfileLinks(links: {
  tiktok_url?: string | null
  youtube_url?: string | null
  instagram_url?: string | null
}): string | null {
  // TikTok is held to the @username form rather than to its host, for the
  // reasons above. The other two are only checked for being the right site:
  // nothing reads a handle out of them.
  const tiktokErr = validateTiktokProfile(links.tiktok_url)
  if (tiktokErr) return tiktokErr
  for (const { field, label, hosts, required } of PROFILE_LINKS) {
    if (field === 'tiktok_url') continue
    const err = validateProfileLink(label, hosts, String(links[field as keyof typeof links] ?? ''), required)
    if (err) return err
  }
  return null
}

// Platforms users report commented-video counts and screenshots for.
// Reddit included: workers comment on Reddit posts, report them on the Finish
// form and are paid the same COMMENT_PAY_RATE as on every other platform.
export const COMMENT_PLATFORMS = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram', 'reddit'] as const

/** The most comments one Finish submission may report, per platform. The
 *  busiest real day on record is ~1,060 opened links; anything far above that
 *  is a typo or abuse, and refused rather than paid. */
export const MAX_COMMENTS_PER_SUBMISSION = 2000

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
// Where the work actually happens.
//
// The guide page is public and meant to be SHARED — a link in a group chat, a
// message to someone who has not joined yet. So it has to send the reader
// somewhere absolute: a relative "/" is wrong the moment the page is read from
// a preview deployment, and useless the moment the text is copied anywhere
// else. Overridable so a domain change needs no code edit.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || 'https://comments-delta-sand.vercel.app'
).replace(/\/+$/, '')

// ONE designated video; a checker reads that video's commenters and marks the
// matching users valid (see 5_comment_verifier). Until then they are held.
//
// Overridable without a redeploy so the video can be rotated.
export const VERIFY_VIDEO_URL =
  process.env.VERIFY_VIDEO_URL ||
  'https://www.tiktok.com/@mypeople334/video/7678712885559692562'

/**
 * How old a TikTok account must be, in days, before it may be used.
 *
 * THE DEFAULT ONLY. The live value is a setting an admin moves without a
 * deploy (getMinAccountAgeDays in lib/db); this is what applies when nothing
 * has been set, and what a nonsensical stored value falls back to.
 *
 * Three months, because a brand-new account is the cheapest thing in this
 * business and its comments are the first TikTok filters away — so work done
 * from one is work that mostly disappears.
 */
export const VERIFY_MIN_AGE_DAYS = Number(process.env.VERIFY_MIN_AGE_DAYS || 90)

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
// MUTABLE ON PURPOSE: lib/genreRegistry.ts appends the products of genres added
// in the admin. Everything reads this array, so they are products everywhere.
export const PRODUCTS: string[] = [
  'purifytext',
  'acoustictext',
  'prohumanly',
  'humlexic',
  'kinprose',
  'tintfolio',
  // Not humanizers. See GENRES below — these two advertise different things to
  // different people, and almost nothing about a humanizer comment transfers.
  'cocodly',
  'pptera',
]
// A plain string, not a union of the names above: products can be added at
// runtime with a new genre (Admin → Genres, lib/genreRegistry.ts), and a type
// that lists them would be wrong the moment one is.
export type Product = string

// ── Genres ───────────────────────────────────────────────────
//
// WHAT A GENRE IS: the kind of thing a product is, and therefore the kind of
// video it belongs under. Every product used to be an AI humanizer, so the
// distinction had nowhere to show itself — one pool of links served all six and
// whichever product already led a video's comment section kept it.
//
// cocodly builds websites and pptera builds slide decks. A humanizer comment
// under a website-builder video is not a weaker advert, it is a stranger talking
// about something else, and the video's own audience is not ours. So a genre
// owns its own links, its own comments and its own share of what workers are
// served, and nothing crosses between them.
//
// THE SIX HUMANIZERS STAY ONE GENRE between themselves. They are substitutes for
// each other, which is exactly why "whichever one already leads this video wins
// it" is the right rule for them and the wrong rule across genres.
//
// THE THREE BELOW ARE BUILT IN; MORE CAN BE ADDED IN THE ADMIN (Genres page).
// lib/genreRegistry.ts appends those to this array and to the tables below at
// startup and whenever the list changes, so every reader of GENRES, isGenre,
// genreOfProduct and productsInGenre sees them without knowing they were added.
export const BUILTIN_GENRES = ['humanizer', 'website', 'slides'] as const
export const GENRES: string[] = [...BUILTIN_GENRES]
export type Genre = string

/**
 * What a link with no genre counts as.
 *
 * Every link scraped before genres existed is a humanizer link, and there are
 * tens of thousands of them in the pool. Reading an absent genre as this is what
 * lets that pool, the verify-list merge and any older upload stay correct
 * without being rewritten.
 */
export const DEFAULT_GENRE: Genre = 'humanizer'

export const PRODUCT_GENRE: Record<string, Genre> = {
  purifytext: 'humanizer',
  acoustictext: 'humanizer',
  prohumanly: 'humanizer',
  humlexic: 'humanizer',
  kinprose: 'humanizer',
  tintfolio: 'humanizer',
  cocodly: 'website',
  pptera: 'slides',
}

/**
 * The cookie holding an admin’s master genre switch.
 *
 * Here, not in lib/adminGenre, because the SWITCH writes it from the browser
 * and the browser cannot import a module that reads request headers. One name,
 * so the writer and the reader cannot drift apart.
 */
export const ADMIN_GENRE_COOKIE = 'admin_genre'

/** Human-readable label for the admin tables. */
export const GENRE_LABELS: Record<string, string> = {
  humanizer: 'Humanizer',
  website: 'Website builder',
  slides: 'Slides',
}

export function isGenre(v: unknown): v is Genre {
  return typeof v === 'string' && (GENRES as readonly string[]).includes(v)
}

/**
 * The genre a product belongs to.
 *
 * An unknown product reads as the default rather than throwing: this is called
 * on the serving path, and a product name that has drifted out of the table
 * should cost one mis-grouped comment, not a page.
 */
export function genreOfProduct(product: string): Genre {
  return PRODUCT_GENRE[product] ?? DEFAULT_GENRE
}

/** Every product in one genre, in PRODUCTS order. */
export function productsInGenre(genre: string): string[] {
  return PRODUCTS.filter((p) => genreOfProduct(p) === genre)
}

/**
 * The genre of one pool row.
 *
 * Takes the whole row rather than a string because the pool is a blob of loosely
 * typed JSON and `genre` is simply absent on most of it — see DEFAULT_GENRE. Kept
 * here beside the table so every reader agrees, which is the thing that stops a
 * link being humanizer on one screen and website on another.
 */
export function genreOfRow(row: { genre?: unknown } | null | undefined): Genre {
  const g = (row as { genre?: unknown } | null)?.genre
  return isGenre(g) ? g : DEFAULT_GENRE
}

/** How much of a worker's list each genre should be. */
export type GenreMix = Record<Genre, number>

/**
 * Everything humanizer until somebody says otherwise.
 *
 * NOT an even split. Two of the three genres have no links and no comments on
 * the day this ships, and a default of 33/33/33 would cut the working pool to a
 * third and fill the rest with nothing.
 */
// An added genre has no entry here and reads as 0: it gets a share only when the
// admin gives it one, like website and slides did.
export const DEFAULT_GENRE_MIX: GenreMix = { humanizer: 100, website: 0, slides: 0 }

/** One share, as a whole number of percent in 0..100. */
export function clampGenreShare(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

/**
 * The shares as WEIGHTS that sum to 1, in GENRES order.
 *
 * NORMALISED, NOT VALIDATED. The admin types three numbers; insisting they total
 * exactly 100 is a box people fight, and 60/20/15 plainly means the same split
 * as 63/21/16. So the ratio between them is what counts.
 *
 * All zero — or a genre list nobody has set — falls back to the default rather
 * than serving nothing, which is the one outcome worse than a wrong ratio.
 */
export function genreWeights(mix: Partial<GenreMix> | null | undefined): GenreMix {
  const raw = GENRES.map((g) => clampGenreShare(mix?.[g]))
  const total = raw.reduce((a, b) => a + b, 0)
  const use = total > 0 ? raw : GENRES.map((g) => DEFAULT_GENRE_MIX[g] ?? 0)
  const sum = use.reduce((a, b) => a + b, 0) || 1
  const out = {} as GenreMix
  GENRES.forEach((g, i) => {
    out[g] = use[i] / sum
  })
  return out
}

/**
 * The genre weights with this worker's PAUSED genres taken out.
 *
 * A genre is paused for one worker when the comment check found too few of
 * their comments on its links (see noCommentVerdict). Its weight goes to zero,
 * which the interleave already treats as "never draw from it", so the other
 * genres fill the list in their own ratio. Every genre paused is an empty
 * feed — correct, since such a worker is blocked rather than paused.
 */
export function withoutGenres(
  weights: Record<string, number>,
  paused: string[] | null | undefined
): Record<string, number> {
  if (!paused || paused.length === 0) return weights
  const out: Record<string, number> = {}
  for (const [g, w] of Object.entries(weights)) out[g] = paused.includes(g) ? 0 : w
  return out
}

/**
 * NO LONGER USED to choose a product — kept only so nothing importing it breaks.
 *
 * A video is now owned by ONE product: whichever already leads its comment
 * section, or one derived from the URL when it has none. Opening every clean
 * video with purifytext would have made purifytext the leader on all of them,
 * and no other product would ever have held a video. See the "Which product a
 * link advertises next" note in lib/db.ts.
 *
 * @deprecated
 */
export const FIRST_ON_EMPTY_PRODUCT: Product = 'purifytext'

// How a product is WRITTEN inside a comment.
//
// NOT AS A BRAND. A comment that announces a name — capitalised, in quotes, one
// keyword string — reads as an advert to a person and as a brand mention to a
// filter, which is the one thing these comments cannot afford to look like.
// Measured: 21 comments posted from four accounts, every one of them naming a
// product as one word, and not one of them was served to any other account that
// went looking for it (see verify_comments.py in 6_comment_liker).
//
// So the name is split into the ordinary words it is made of and written
// lowercase, as part of the sentence: "i just purify text mine before handing
// it in". No quotes, no capital, no hashtag.
//
// NOTHING DOWNSTREAM BREAKS, and that is a constraint on the split rather than
// a happy accident: every product matcher strips non-alphanumerics before
// comparing (norm() in commentScan, replyGen and linkCategory) and then asks
// whether the flattened product name is a SUBSTRING. "purify text" flattens to
// purifytext, and so does "purify texting" — the suffix lands at the end, after
// the whole name. A form that changed the stem, "purity texting", would read
// just as well and would be invisible to every check we have, including the
// admin's own "does this worker's comment exist" read. So the stem is never
// touched; only the seam and the tail.
const PRODUCT_WORDS: Record<string, string> = {
  purifytext: 'purify text',
  acoustictext: 'acoustic text',
  prohumanly: 'pro humanly',
  humlexic: 'hum lexic',
  kinprose: 'kin prose',
  tintfolio: 'tint folio',
  cohumanly: 'co humanly',
}

// The forms a comment may use, first one canonical.
//
// Only where the inflection is real English. "purify texted my essay" is a
// sentence; "pro humanlyed" is not, so those products get the split form alone
// and the model is not invited to invent one.
const PRODUCT_FORMS: Record<string, readonly string[]> = {
  purifytext: ['purify text', 'purify texts', 'purify texted', 'purify texting'],
  acoustictext: ['acoustic text', 'acoustic texts', 'acoustic texting'],
  tintfolio: ['tint folio', 'tint folios'],
}

/** The product name as it should appear in a comment, without the quotes. */
export function productWords(product: string, split = true): string {
  return split ? PRODUCT_WORDS[product] ?? product : product
}

/**
 * Every phrasing a comment is allowed to use for this product, canonical first.
 *
 * Handed to the model so it can pick the one that fits the sentence it is
 * writing, which is the difference between a name dropped into a gap and a
 * product somebody is talking about.
 */
export function productForms(product: string): readonly string[] {
  return PRODUCT_FORMS[product] ?? [productWords(product)]
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
  /**
   * No longer honoured: a quoted name is a name being announced, which is what
   * a comment must not do. Kept so stored settings and the API still parse.
   *
   * @deprecated
   */
  quoteBrand: boolean
  /**
   * Which of three pitches the comment makes. Not three wordings — three
   * different things to be, and which one lands is a thing to try rather than
   * reason about, so it is a setting.
   *
   *   question       the claim is PRESUPPOSED and the comment asks about
   *                  something else — "why does nothing else come back 0% like
   *                  purify text does?". The reader draws the conclusion.
   *   recommendation a person saying what they use and why it worked —
   *                  "i switched to purify text and mine passes now".
   *   informational  a neutral fact, no endorsement and no superlative —
   *                  "purify text rewrites ai text so detectors read it as
   *                  human". Says what the thing IS, and lets that stand.
   *   curious        a question asked of a PERSON, that genuinely wants an
   *                  answer — "what made you switch to purify text? the flow
   *                  reads really clean". The product is an aside inside a
   *                  question about them, not the subject of it.
   *
   * question and curious are both questions and are not the same thing. The
   * first is rhetorical and expects no reply: it presupposes the claim and asks
   * around it. The second is addressed to someone, wants a reply, and mentions
   * the product in passing — which is what makes the endorsement incidental
   * rather than the point.
   */
  voice: CommentVoice
}

export type CommentVoice = 'question' | 'recommendation' | 'informational' | 'curious'
export const COMMENT_VOICES: readonly CommentVoice[] = [
  'question',
  'recommendation',
  'informational',
  'curious',
] as const
export function isCommentVoice(v: unknown): v is CommentVoice {
  return typeof v === 'string' && (COMMENT_VOICES as readonly string[]).includes(v)
}

export const DEFAULT_COMMENT_STYLE: CommentStyle = {
  emoji: true,
  splitBrand: true,
  quoteBrand: false,
  voice: 'question',
}

/**
 * The brand exactly as it should appear in a comment, under these settings.
 *
 * QUOTING IS GONE, whatever the stored style says. It was on by default, so
 * every comment generated up to now announced its product in double quotes —
 * the most brand-like way there is to write a name, and unlike the splitting
 * it fooled nobody. The switch is left in the type and the table only because
 * rows already hold it.
 */
export function productMention(product: string, style: CommentStyle = DEFAULT_COMMENT_STYLE): string {
  return productWords(product, style.splitBrand).toLowerCase()
}

// ── AUTO-BLOCK RULES, as settings rather than as constants ────────────────
//
// Two rules decide whether the comment check blocks somebody, and both of their
// numbers were baked into the code:
//
//   nothing found on N judged links                (N was 50)
//   under P% of their last M judged links carry one (P was 10, M was 200)
//
// They are judgements about people, made nightly, so they belong to whoever is
// answerable for them. Kept here — not in commentPresence — because this file is
// the one both the browser and the database layer can import.
//
// THE BOUNDS ARE NOT DECORATION. Each one guards against a setting that would
// quietly make the rule meaningless or vicious:
//
//   sample 20-80     below 20 an honest worker who hit a run of hidden comments
//                    is blocked on a handful of links. Above ~80 the search runs
//                    out of candidates — finding N judgeable links needs roughly
//                    6N recent ones and getRecentClickedLinks stops at 500 — so
//                    the count stalls short of the target for ever and the rule
//                    silently never fires.
//   ratio 1-50%      at 0 it can never fire; above 50 it blocks the median
//                    worker, who on the real data sits around 20%.
//   window 50-300    the denominator is read from verdicts the sweeps have
//                    already made. Past 300 most people do not have that many
//                    judged links and the rule cannot speak at all.
export interface BlockRules {
  /** Master switch. Off means no check blocks anybody, by any rule. */
  on: boolean
  /** Judged links with NOTHING found before the first rule may block. */
  sample: number
  /** Judged links the rate rule needs before it may speak. */
  ratioSample: number
  /** Below this percentage found, the rate rule blocks. */
  ratioMinPct: number
  /**
   * THE GENRE RULE. Below this percentage found on one genre's links, that
   * genre stops being served to the worker; below it in EVERY genre they have
   * enough judged links in, they are blocked.
   */
  genreMinPct: number
  /** Judged links a genre needs before the genre rule may judge it. */
  genreSample: number
}

export const BLOCK_RULE_DEFAULTS: BlockRules = {
  on: true,
  sample: 50,
  ratioSample: 200,
  ratioMinPct: 10,
  genreMinPct: 10,
  genreSample: 50,
}

export const BLOCK_RULE_BOUNDS = {
  sample: { min: 20, max: 80 },
  ratioSample: { min: 50, max: 300 },
  ratioMinPct: { min: 1, max: 50 },
  // Same range as the rate rule, for the same reasons. The sample floor is the
  // empty rule's: fewer judged links than that is a run of luck, not a rate.
  genreMinPct: { min: 1, max: 50 },
  genreSample: { min: 20, max: 300 },
} as const

/**
 * Pull a number into range, keeping the default when there is nothing to read.
 *
 * NOTHING MEANS UNCHANGED, not the floor. Number('') is 0, so clamping an empty
 * field straight away turned "I cleared the box to retype" into the harshest
 * setting there is — which is how a sweep once nearly blocked people on twenty
 * links.
 */
export function clampRule(v: unknown, key: keyof typeof BLOCK_RULE_BOUNDS): number {
  const dflt = BLOCK_RULE_DEFAULTS[key]
  if (v === null || v === undefined) return dflt
  if (typeof v === 'string' && v.trim() === '') return dflt
  const n = Number(v)
  if (!Number.isFinite(n)) return n === Infinity ? BLOCK_RULE_BOUNDS[key].max : dflt
  const b = BLOCK_RULE_BOUNDS[key]
  return Math.max(b.min, Math.min(b.max, Math.round(n)))
}

// ── SERVE THE COMMENTS THAT ACTUALLY LANDED ───────────────────────────────
//
// The bank is what somebody WROTE for a product; link_product_comment is what
// turned out to be on the videos, and clicked_link says how often each was handed
// out to get there. With this on, a click is answered from the top few of a
// product's own comments over a recent window instead of from the bank.
//
// WHAT IT COSTS, and the page says so: the bank is written per AUDIENCE and this
// list is not. Turning it on trades matching the comment to the video for
// serving what measurably worked.
export type TopListRank = 'links' | 'ratio' | 'balanced'

export interface TopListSetting {
  /** Serve from the measured top list instead of the written bank. */
  enabled: boolean
  /** How many of the best to draw from. */
  count: number
  /** links = reach, ratio = yield, balanced = half of each. */
  rank: TopListRank
  /** How far back the measurement looks, in days. */
  days: number
  /**
   * Spellings to write the product name in when serving from this list - e.g.
   * ρυrіfуtеxt for purifytext. One is picked at random per serve; empty means
   * the comment's own spelling. Each must fold back to the product name (see
   * lib/lookalike.ts), or the scan could no longer tell the comment is ours.
   */
  aliases: string[]
}

export const DEFAULT_TOP_LIST: TopListSetting = {
  enabled: false,
  count: 20,
  rank: 'balanced',
  days: 30,
  aliases: [],
}

/** At most this many name spellings per product, each at most TOP_ALIAS_MAX_LEN. */
export const TOP_ALIAS_MAX = 20
export const TOP_ALIAS_MAX_LEN = 40

/**
 * Each listed comment's chance of being served, in percent, in list order.
 *
 * PROPORTIONAL TO ITS RATIO - how often a serving of it actually lands on the
 * video. A comment at 30% is served three times as often as one at 10%. One
 * with no ratio yet (too few servings to judge, only possible under "most
 * links") is weighted at the list's average ratio, so it is neither favoured
 * nor starved while it earns one. A list with no ratio above zero anywhere is
 * served evenly.
 */
export function topServeChances(rows: { ratio: number | null }[]): number[] {
  if (rows.length === 0) return []
  const known = rows.map((r) => r.ratio).filter((x): x is number => x !== null && x > 0)
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 0
  const w = rows.map((r) => (r.ratio === null ? avg : Math.max(0, r.ratio)))
  const total = w.reduce((a, b) => a + b, 0)
  if (total <= 0) return rows.map(() => 100 / rows.length)
  return w.map((x) => (100 * x) / total)
}

export const TOP_LIST_BOUNDS = {
  // Below about five the same sentence goes under every video, which is the
  // pattern one search finds. Above a couple of hundred it is not a top list.
  count: { min: 5, max: 200 },
  // A week is the shortest window with enough scanned links to rank on; beyond a
  // year "recent" means nothing.
  days: { min: 7, max: 365 },
} as const

export function isTopListRank(v: unknown): v is TopListRank {
  return v === 'links' || v === 'ratio' || v === 'balanced'
}

/**
 * Pull a stored or posted setting into range, keeping the defaults for gaps.
 *
 * The input is deliberately untyped per field: it arrives as a query string, as
 * a JSON body, or as a database row, and the whole point of this function is to
 * be the one place that turns any of those into a usable setting.
 */
export function clampTopList(
  v: Partial<Record<keyof TopListSetting, unknown>> | null | undefined
): TopListSetting {
  const n = (x: unknown, key: keyof typeof TOP_LIST_BOUNDS): number => {
    const b = TOP_LIST_BOUNDS[key]
    const d = DEFAULT_TOP_LIST[key]
    if (x === null || x === undefined || (typeof x === 'string' && x.trim() === '')) return d
    const num = Number(x)
    if (!Number.isFinite(num)) return d
    return Math.max(b.min, Math.min(b.max, Math.round(num)))
  }
  return {
    enabled: typeof v?.enabled === 'boolean' ? v.enabled : DEFAULT_TOP_LIST.enabled,
    count: n(v?.count, 'count'),
    rank: isTopListRank(v?.rank) ? v.rank : DEFAULT_TOP_LIST.rank,
    days: n(v?.days, 'days'),
    aliases: Array.isArray(v?.aliases)
      ? Array.from(
          new Set(
            (v.aliases as unknown[])
              .map((a) => String(a ?? '').trim())
              .filter((a) => a && a.length <= TOP_ALIAS_MAX_LEN)
          )
        ).slice(0, TOP_ALIAS_MAX)
      : DEFAULT_TOP_LIST.aliases,
  }
}

export function isProduct(v: unknown): v is Product {
  return typeof v === 'string' && (PRODUCTS as readonly string[]).includes(v)
}

// Products that are temporarily unavailable — shown disabled in the admin
// dropdown and not assignable, and left out of the app's comment pool. Add a
// product here to switch it off; remove it to re-enable. Currently none are off:
// every product in PRODUCTS is live.
export const DEACTIVATED_PRODUCTS: readonly Product[] = []

/**
 * The banks a worker can pick when they give their account number.
 *
 * Ethiopia's licensed commercial banks, plus the two mobile-money wallets
 * workers are paid into. Not exhaustive by design — banks open and merge — so
 * the form always offers "Other" with a box to type the name in.
 */
export const ETHIOPIAN_BANKS: readonly string[] = [
  'Commercial Bank of Ethiopia',
  'Awash Bank',
  'Bank of Abyssinia',
  'Dashen Bank',
  'Cooperative Bank of Oromia',
  'Wegagen Bank',
  'Hibret Bank',
  'Nib International Bank',
  'Oromia Bank',
  'Zemen Bank',
  'Bunna Bank',
  'Berhan Bank',
  'Abay Bank',
  'Lion International Bank',
  'Enat Bank',
  'Addis International Bank',
  'Debub Global Bank',
  'Global Bank Ethiopia',
  'Amhara Bank',
  'Tsehay Bank',
  'Siinqee Bank',
  'ZamZam Bank',
  'Hijra Bank',
  'Shabelle Bank',
  'Ahadu Bank',
  'Gadaa Bank',
  'Goh Betoch Bank',
  'Tsedey Bank',
  'Sidama Bank',
  'Omo Bank',
  'Rammis Bank',
  'Development Bank of Ethiopia',
  'telebirr',
  'M-PESA',
]

// Payment (birr) a user earns per approved 30s–1min video they submit.
export const VIDEO_PAYMENT_BIRR = 150

// Birr paid per comment a user makes. Total owed for comments =
// (total comments since last reset) x COMMENT_PAY_RATE.
export const COMMENT_PAY_RATE = 0.5

// ── Referrals ────────────────────────────────────────────────────────────────
// Every user has a referral username. Somebody entering it when they register
// is permanently attributed to them, and from then on 20% of that person's
// COMMENT pay is paid to the referrer ON TOP -- it is never deducted from the
// worker, who is paid exactly what they would have been paid anyway.
//
// ONE LEVEL ONLY. The referrer of a referrer earns nothing from the second
// level: a chain pays a percentage of a percentage forever, and the first
// person to notice builds a pyramid out of it.
//
// Comments are the only task that pays a commission. The video, repost and
// email tasks are one-off amounts an admin approves by hand, and attaching a
// silent 20% to a 150-birr approval is the kind of thing that is discovered
// afterwards.
export const REFERRAL_SHARE = 0.2

/** Birr a referrer earns per comment made by somebody they referred. */
export const REFERRAL_PAY_RATE = COMMENT_PAY_RATE * REFERRAL_SHARE

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

// ── What the Links page search box looks in ──────────────────────────────────
//
// Five fields, each answering a different question, which is why they are
// pickable rather than all searched at once:
//
//   url      the link itself — an id, and the handle for TikTok/YouTube
//   keyword  the search term the link was SCRAPED under, not what it contains
//   title    the video's own caption: what it is actually about
//   channel  the account that posted it
//   bio      that account's profile description — what the channel is FOR,
//            which the individual captions often do not say
//
// A wider search is not a better one: typing "humanizer" with bio on matches
// every link from every channel whose profile mentions humanizers, which is
// thousands, and buries the caption you were looking for.
export const SEARCH_FIELDS = [
  { key: 'url', label: 'URL' },
  { key: 'keyword', label: 'Keyword' },
  { key: 'title', label: 'Title' },
  { key: 'channel', label: 'Channel name' },
  { key: 'bio', label: 'Channel bio' },
] as const

export type SearchField = (typeof SEARCH_FIELDS)[number]['key']

/**
 * What the box searches when nothing is chosen.
 *
 * The three that describe the LINK. Channel and bio describe the account, so a
 * hit on them is a hit on every one of that channel's links at once — useful
 * deliberately, surprising by default.
 */
export const DEFAULT_SEARCH_FIELDS: readonly SearchField[] = ['url', 'keyword', 'title']

export function isSearchField(v: unknown): v is SearchField {
  return typeof v === 'string' && SEARCH_FIELDS.some((f) => f.key === v)
}

// ── Mailbox task (users create addresses on the company's own domain) ────────
// A worker creates a mailbox on a domain THE COMPANY OWNS and submits the
// address. Nothing is transferred from the worker: the domain, the mailbox and
// the credentials belong to the company from the moment the address exists.
//
// The address is worth ACCOUNT_PAY_BIRR, and it is worth NOTHING until an admin
// has checked it really exists on the domain. So a submission earns in two
// steps — see PendingPayments.accountsAwaiting (submitted, unapproved, not
// payable) and .accounts (validated, payable).
export const ACCOUNT_PAY_BIRR = 50

/** Fallback domain, used until an admin saves one on the admin tasks page. */
export const ACCOUNT_TASK_DEFAULT_DOMAIN = process.env.ACCOUNT_TASK_DOMAIN ?? ''

/**
 * The password workers are told to set on the mailbox they create.
 *
 * Set on the admin tasks page and stored in the database, with this env var as
 * the fallback — NOT written into the source. It is shown to every worker, so
 * it is not a secret in any useful sense, but a literal password in a committed
 * file is a thing that outlives the reason for it and turns up in a repository
 * search years later. Blank means "we do not tell them", and the page then says
 * nothing about a password rather than showing an empty box.
 *
 * ONE PASSWORD ACROSS EVERY MAILBOX is the operator's decision. It means one
 * leak is all of them and no single mailbox can be locked out on its own; since
 * the company owns the domain, generating a different password per address
 * costs the same effort and avoids both.
 */
export const ACCOUNT_TASK_DEFAULT_PASSWORD = process.env.ACCOUNT_TASK_PASSWORD ?? ''

/**
 * The recovery address workers are told to put on the mailbox they create.
 *
 * Written into the source, unlike the password, because it is not a credential:
 * it is where the provider sends a reset link, and the whole point is that it is
 * OURS. A mailbox whose recovery address belongs to the worker is one we can be
 * locked out of the day they change their mind, and the task exists to produce
 * addresses the company controls.
 *
 * Overridable on the admin tasks page and by ACCOUNT_TASK_RECOVERY, so it can be
 * changed without a deploy when the address does. Blank means "we do not ask for
 * one", and the page then says nothing about it rather than showing an empty box.
 */
export const ACCOUNT_TASK_DEFAULT_RECOVERY =
  process.env.ACCOUNT_TASK_RECOVERY ?? 'workinehmisgana@gmail.com'

/**
 * Is this an address on the company's domain?
 *
 * The whole point of the task is addresses WE control, so an address anywhere
 * else is not a smaller version of the work — it is the thing we declined to
 * pay for. Checked on submission rather than only at review, so a worker is
 * told immediately instead of waiting for a rejection.
 *
 * A blank domain means one has not been configured; the caller must refuse the
 * submission rather than accept anything.
 */
export function isCompanyEmail(email: string, domain: string): boolean {
  const e = String(email ?? '').trim().toLowerCase()
  const d = String(domain ?? '').trim().toLowerCase().replace(/^@/, '')
  if (!d) return false
  // One @, a non-empty local part, and no whitespace anywhere.
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return false
  return e.endsWith(`@${d}`)
}

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
// REDDIT IS HERE SO THAT A REDDIT LINK IS CALLED A REDDIT LINK.
//
// platformFromUrl falls back to 'tiktok' for a host it does not know, and the
// search scraper can now collect Reddit posts — so every one of them uploaded
// would have been filed as TikTok: counted against the TikTok quota, shown to
// workers as TikTok work, and impossible to filter out of the pool afterwards.
// The same fallback did this to the verify list once before.
//
// It is a full platform: served in the web dashboard and the app with its own
// tab and its own hourly quota, and reported and paid as comment work
// (COMMENT_PLATFORMS). The liker still does not offer it — it only knows how to
// press TikTok's heart.
export const CLICK_PLATFORMS = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram', 'reddit'] as const
export type ClickPlatform = (typeof CLICK_PLATFORMS)[number]

/**
 * Which platform a link belongs to, read from the URL itself.
 *
 * The URL is the only trustworthy source. Rows arrive from CSV uploads, channel
 * scrapes and the verify list, and each of those had its own idea of what to put
 * in a platform field — the verify list defaulted every row to 'tiktok' and
 * never wrote anything else, so 68k Instagram links were all labelled TikTok.
 * Mislabelling is not cosmetic: platform decides which tab a link appears under,
 * which hourly quota it counts against, and which retirement threshold applies.
 *
 * Falls back to 'tiktok' for an unrecognised host, which is what every caller
 * assumed before this existed.
 */
export function platformFromUrl(url: string): ClickPlatform {
  const u = String(url ?? '').toLowerCase()
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('youtube.com') || u.includes('youtu.be')) {
    return u.includes('/shorts/') ? 'youtube_shorts' : 'youtube_videos'
  }
  if (u.includes('reddit.com')) return 'reddit'
  return 'tiktok'
}

/**
 * Repair a pool row's platform in place, from its URL, when the stored one is
 * not a platform we serve.
 *
 * upload.py tagged every Reddit post 'unknown' (its URL parser knew TikTok,
 * YouTube and Instagram only), so 1,503 Reddit links sat in the pool under a
 * platform no feed has a tab for and were never served. Every pool loader runs
 * its rows through this, so those rows are Reddit everywhere at once, and the
 * next write of the pool file (an upload, a recluster) stores them fixed.
 *
 * ONLY for a host we recognise. platformFromUrl answers 'tiktok' for anything
 * else, and turning an unknown host into TikTok work is the exact mislabel
 * this exists to undo.
 */
export function repairRowPlatform<T extends { url?: unknown; platform?: unknown }>(row: T): T {
  if (!row || (CLICK_PLATFORMS as readonly string[]).includes(String(row.platform ?? ''))) return row
  const u = String(row.url ?? '').toLowerCase()
  if (/tiktok\.com|instagram\.com|youtube\.com|youtu\.be|reddit\.com/.test(u)) {
    ;(row as { platform?: unknown }).platform = platformFromUrl(u)
  }
  return row
}

export const CLICK_PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  youtube_shorts: 'YT Shorts',
  youtube_videos: 'YT Videos',
  instagram: 'Instagram',
  // A missing key here renders as an empty cell rather than as an error, which
  // is how a new platform goes unnoticed on the admin screens.
  reddit: 'Reddit',
}

// One platform's rule. TWO independent per-platform switches:
//   • `enabled`       — the HOURLY quota: `limit` links per rolling `windowMs`
//                       (`limit <= 0` means unlimited / never locked). Applies on
//                       its own, whatever the master switch says.
//   • `retireEnabled` — LINK RETIREMENT for this platform (a link leaving the pool
//                       once enough distinct users have clicked it). Applies only
//                       when the MASTER switch and this flag are both on.
//   • `harvestEnabled` — AUTOMATIC CHANNEL EXTRACTION for this platform: the
//                       pipeline's harvest stage looking at this platform's
//                       channels for videos we have never seen. Off means the
//                       pipeline never visits them; nothing else changes, and
//                       links already in the pool keep being served.
export interface PlatformLimit {
  limit: number
  windowMs: number
  enabled: boolean
  retireEnabled: boolean
  harvestEnabled: boolean
}

// Default rule for every platform (used until the admin overrides it). Both
// switches default on, so behaviour only changes where the admin explicitly
// switches something off.
export const DEFAULT_PLATFORM_LIMIT: PlatformLimit = {
  limit: HOURLY_LINK_LIMIT,
  windowMs: HOURLY_WINDOW_MS,
  enabled: true,
  retireEnabled: true,
  harvestEnabled: true,
}

/**
 * The click platforms a CHANNEL on one site can produce links for.
 *
 * The harvest works on channels, and a channel belongs to a site, while every
 * switch in the dashboard is per click platform. YouTube is the reason this
 * mapping is not the identity: one channel's uploads are Shorts AND ordinary
 * videos, and which of the two a new upload is cannot be known before it is
 * fetched. So a YouTube channel is visited while EITHER switch is on.
 */
export const CHANNEL_SITE_PLATFORMS: Record<string, readonly ClickPlatform[]> = {
  tiktok: ['tiktok'],
  instagram: ['instagram'],
  youtube: ['youtube_shorts', 'youtube_videos'],
}

// ── AI comment rewriting (Groq) ──────────────────────────────────────────────
// The click-to-copy comments on /comments are periodically rewritten by an LLM
// into fresh, very short variants that keep the same theme but always mention
// the product. The originals in lib/comments.ts act as the theme source.
export const COMMENT_REFRESH_MS = 24 * 60 * 60 * 1000 // regenerate every 24 hours
// Models tried in order; on a rate-limit/quota error (HTTP 429) the request
// automatically falls back to the next one.
// The models an admin can choose between, and the one used when nothing is
// chosen. Both are checked against what the API key can actually serve — the
// previous list carried 'llama-3.3-70b-versatile' and 'qwen/qwen3.6-27b'; the
// first is not served to this key at all, so as a fallback it could only ever
// turn a rate limit into a hard error.
export const LLM_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
] as const
export type LlmModel = (typeof LLM_MODELS)[number]
export const DEFAULT_LLM_MODEL: LlmModel = 'gemini-3.5-flash-lite'

export function isLlmModel(v: unknown): v is LlmModel {
  return typeof v === 'string' && (LLM_MODELS as readonly string[]).includes(v)
}

/**
 * Who serves a model, read from its name.
 *
 * Read rather than stored beside it: a second list of which model belongs to
 * which provider is a second list to forget to update, and the names already
 * say it. Groq is the fallback reading so an id that is neither ends up on the
 * provider this app had before Gemini existed, rather than nowhere.
 */
export type LlmProvider = 'groq' | 'gemini'

export function llmProvider(model: string): LlmProvider {
  return model.startsWith('gemini') ? 'gemini' : 'groq'
}

/** Human labels for the picker. The provider is in the label because the two
 *  need different API keys, and "it stopped working" is usually one of them. */
export const LLM_MODEL_LABELS: Record<LlmModel, string> = {
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite (Google)',
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite (Google)',
  'openai/gpt-oss-120b': 'GPT-OSS 120B (Groq)',
  'qwen/qwen3.8-27b': 'Qwen3.8 27B (Groq)',
}

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/**
 * Title classification: how many titles may go in ONE request, and how many a
 * caller actually sends.
 *
 * THESE WERE THREE SEPARATE NUMBERS AND THE DISAGREEMENT WAS SILENT. The route
 * took `.slice(0, 120)`; the verify page sent a fifth of its page (100 on a
 * 500-row page, by coincidence of the page size); the main Links page sent the
 * whole page in one request — up to 500 titles, of which 380 were dropped
 * unseen. Dropped titles come back absent from `related`, and "unrelated" is
 * defined as "not related", so every one of them was ticked as
 * humanizer-unrelated without being read, ready for the Block button.
 *
 * BATCH must stay <= MAX. The route now refuses anything larger than MAX rather
 * than trimming it, because a silently trimmed batch is indistinguishable from a
 * classified one.
 */
export const CLASSIFY_MAX_ITEMS = 120
export const CLASSIFY_BATCH = 100
// Rewrites must be this many words (inclusive) and mention the product name.
export const COMMENT_WORD_MIN = 3
export const COMMENT_WORD_MAX = 8
