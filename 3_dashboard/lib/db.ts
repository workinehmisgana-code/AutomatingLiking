import { Pool } from 'pg'
import { del } from '@vercel/blob'
import { randomBytes } from 'crypto'
import {
  COMMENT_PAY_RATE,
  VIDEO_PAYMENT_BIRR,
  PROMO_PAY_BIRR,
  ACCOUNT_PAY_BIRR,
  ACCOUNT_TASK_DEFAULT_DOMAIN,
  ACCOUNT_TASK_DEFAULT_PASSWORD,
  PROMO_DOWNLOAD_DAILY_LIMIT,
  CLICK_EXCLUDED_EMAILS,
  CLICK_PLATFORMS,
  type ClickPlatform,
  DEFAULT_PLATFORM_LIMIT,
  type PlatformLimit,
  PRODUCTS,
  DEACTIVATED_PRODUCTS,
  isProduct,
  platformFromUrl,
  isLlmModel,
  DEFAULT_LLM_MODEL,
  type LlmModel,
  type DateWeights,
  DEFAULT_DATE_WEIGHTS,
  normalizeDateWeights,
  COMMENT_WORD_MIN,
  COMMENT_WORD_MAX,
  type CommentStyle,
  isCommentVoice,
  DEFAULT_COMMENT_STYLE,
} from './config'
import { isGenericTitle } from './titleFilter'
import { clampShare } from './clusterMix'

const rawUrl = process.env.DATABASE_URL || ''
// Neon / most hosted Postgres require SSL; local dev usually doesn't.
const needsSSL =
  rawUrl.includes('sslmode=') || /neon\.tech|supabase|amazonaws|render\.com/.test(rawUrl)

/**
 * The connection string with any `sslmode` parameter removed.
 *
 * pg-connection-string warns on every boot that 'prefer' / 'require' /
 * 'verify-ca' are currently treated as 'verify-full' and will change meaning in
 * pg v9 — noise in the Vercel logs, and a real trap: on that upgrade a
 * `sslmode=require` URL would start demanding a verifiable certificate chain,
 * which hosted Postgres behind a proxy does not always present, and every query
 * would fail at once.
 *
 * Stripping it makes the explicit `ssl` option below the single source of truth.
 * SSL is still ON — passing an ssl object enables it — so nothing about the
 * connection changes today, and the pg v9 semantics change cannot reach us.
 */
function stripSslMode(raw: string): string {
  const re = /([?&])sslmode=[^&]*(&|$)/gi
  let out = raw
  // Looped: one global pass consumes the separator between two adjacent
  // sslmode params, so a repeated parameter would survive a single replace.
  for (let prev = ''; prev !== out; ) {
    prev = out
    out = out.replace(re, (_m, pre: string, post: string) => (post === '&' ? pre : ''))
  }
  return out
}
const url = stripSslMode(rawUrl)

// Reuse a single Pool across hot-reloads / serverless invocations.
const globalForPool = globalThis as unknown as { _pgPool?: Pool }

export const pool =
  globalForPool._pgPool ??
  new Pool({
    connectionString: url,
    ssl: needsSSL ? { rejectUnauthorized: false } : undefined,
    max: 5,
  })

if (!globalForPool._pgPool) globalForPool._pgPool = pool

// Lazily create the per-user click-tracking table (runs once per process).
let ensured: Promise<void> | null = null

export function ensureClickedTable(): Promise<void> {
  if (!ensured) {
    ensured = pool
      .query(`
        CREATE TABLE IF NOT EXISTS clicked_link (
          id           BIGSERIAL PRIMARY KEY,
          user_id      TEXT NOT NULL,
          url          TEXT NOT NULL,
          search_query TEXT,
          platform     TEXT,
          -- The product this click was made FOR, stamped at click time. Retirement
          -- is counted per product, so this must be frozen here: reading it from
          -- the user's CURRENT product instead would silently re-attribute every
          -- past click whenever a user is moved to a different product.
          product      TEXT,
          clicked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, url)
        );
        ALTER TABLE clicked_link ADD COLUMN IF NOT EXISTS product TEXT;
        -- The comment the server handed out for this click. Stored because it
        -- is the only record of what the user was ASKED to post: for a link
        -- where the comment never appeared, the assigned text is the evidence,
        -- and it cannot be reconstructed later from a pool that rotates daily.
        ALTER TABLE clicked_link ADD COLUMN IF NOT EXISTS served_comment TEXT;
        CREATE INDEX IF NOT EXISTS clicked_link_user_idx ON clicked_link (user_id);
        CREATE INDEX IF NOT EXISTS clicked_link_url_idx ON clicked_link (url);
        -- Per-product counting is the hot path for retirement.
        CREATE INDEX IF NOT EXISTS clicked_link_product_url_idx ON clicked_link (product, url);
        -- Lets the one-time backfill probe below be O(1); empty once it has run.
        CREATE INDEX IF NOT EXISTS clicked_link_unstamped_idx ON clicked_link (id) WHERE product IS NULL;

        -- Links users flagged as unrelated to humanizers (does NOT count toward
        -- the click/retire quota). One flag per user per link.
        CREATE TABLE IF NOT EXISTS unrelated_link (
          id          BIGSERIAL PRIMARY KEY,
          user_id     TEXT NOT NULL,
          url         TEXT NOT NULL,
          platform    TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, url)
        );
        CREATE INDEX IF NOT EXISTS unrelated_link_url_idx ON unrelated_link (url);

        -- Links the admin permanently blocked (indeed unrelated). Kept separate
        -- from videos.json so a blocked link stays hidden even if a newly uploaded
        -- list re-introduces it — filtered out at serve time, never deleted.
        CREATE TABLE IF NOT EXISTS blocked_link (
          url        TEXT PRIMARY KEY,
          blocked_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- Links the platform no longer serves: deleted, made private, or taken
        -- down. Held apart from blocked_link because they are a different fact
        -- and have a different fate — a block is a judgement we made and keep,
        -- while a broken link is a state of the world that can reverse itself
        -- when a post is unhidden or a region block lifts.
        --
        -- misses counts CONSECUTIVE dead readings. One is never enough: the
        -- same empty response comes back from a rate limit or a bad minute on
        -- TikTok's side, and condemning a live link on one reading would quietly
        -- shrink the pool.
        -- Clicks made while "serve only links with none of ours" is ON.
        --
        -- Held apart from clicked_link because it answers a different question
        -- and has a different lifetime. clicked_link is the permanent record of
        -- what a user has ever opened, and while that setting is on it is
        -- deliberately IGNORED so a link with none of ours comes back round.
        -- Without a second record a user would then be handed the same link on
        -- every fetch of the session. This is that record, and it is wiped every
        -- time the setting is switched, so each ON session starts empty.
        CREATE TABLE IF NOT EXISTS clean_session_click (
          user_id    TEXT NOT NULL,
          url        TEXT NOT NULL,
          clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, url)
        );

        CREATE TABLE IF NOT EXISTS broken_link (
          url          TEXT PRIMARY KEY,
          reason       TEXT NOT NULL DEFAULT '',
          misses       INT  NOT NULL DEFAULT 1,
          first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_checked TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS broken_link_seen_idx ON broken_link (first_seen DESC);

        -- Cached video titles (fetched once from the platform, reused forever).
        CREATE TABLE IF NOT EXISTS link_title (
          url        TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Live engagement counts refreshed from TikTok's embed endpoint, kept
        -- out of videos.json so a refresh pass is a cheap upsert per batch
        -- instead of a 24 MB blob rewrite. Overlaid onto the pool at read time.
        -- Audience category per link, decided from its caption + channel bio.
        -- Kept out of videos.json for the same reason as link_stat: categorising
        -- a batch is an upsert, not a 24 MB blob rewrite.
        -- One day's comment-presence score for one user: of the links they
        -- opened that day, how many actually carry a comment from their own
        -- account. Stored per DAY so the badge can be an average over time
        -- rather than a single snapshot that a bad afternoon would ruin.
        CREATE TABLE IF NOT EXISTS comment_presence (
          user_id    TEXT NOT NULL,
          day        DATE NOT NULL,
          checked    INT  NOT NULL,
          found      INT  NOT NULL,
          -- Links we could not judge (unresolvable, or more comments than
          -- TikTok will serve). Excluded from the percentage rather than
          -- counted as a miss.
          skipped    INT  NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, day)
        );
        -- One judged link. This is the RESUME LEDGER: a user can open 160 links
        -- in a day and reading them all takes minutes, far past a serverless
        -- request, so the work has to survive being cut off part-way. Recording
        -- each link also makes a re-run idempotent — already-judged links are
        -- skipped instead of counted twice.
        CREATE TABLE IF NOT EXISTS comment_presence_link (
          user_id   TEXT NOT NULL,
          day       DATE NOT NULL,
          url       TEXT NOT NULL,
          found     BOOLEAN NOT NULL,
          judgeable BOOLEAN NOT NULL,
          checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, day, url)
        );
        -- What the user actually wrote, and how many comments the video has.
        -- Both come free from the read that judged the link; without them the
        -- admin has only a true/false and no way to check the machine's work.
        ALTER TABLE comment_presence_link ADD COLUMN IF NOT EXISTS comment_text TEXT;
        ALTER TABLE comment_presence_link ADD COLUMN IF NOT EXISTS comment_total INT;
        CREATE INDEX IF NOT EXISTS comment_presence_link_day
          ON comment_presence_link (user_id, day);
        -- The numeric TikTok id behind a user's @handle, learned from a comment
        -- of theirs that a presence check found. TikTok returns it in the
        -- comment list and nowhere else, and it is a snowflake — so it dates
        -- the account (see lib/tiktokId). One row per user, keyed to the handle
        -- it was learned from, so changing the profile link invalidates it
        -- rather than silently dating the wrong account.
        CREATE TABLE IF NOT EXISTS tiktok_account (
          user_id    TEXT PRIMARY KEY,
          handle     TEXT NOT NULL,
          uid        TEXT NOT NULL,
          seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- One turn of the automatic cycle: harvest -> extract -> categorise
        -- -> recluster. app_kv only ever holds the LATEST tick, which answers
        -- "what is it doing now" and nothing about what it has done — so every
        -- cycle gets a row here and each stage folds its totals in as it
        -- finishes.
        CREATE TABLE IF NOT EXISTS pipeline_cycle (
          id          BIGSERIAL PRIMARY KEY,
          started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at TIMESTAMPTZ,
          -- {"harvest": {...}, "extract": {...}, ...} — whatever each stage
          -- reported, kept whole rather than flattened into columns that would
          -- need a migration every time a stage learns to report something new.
          stages      JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS pipeline_cycle_started
          ON pipeline_cycle (started_at DESC);
        -- What the extract stage found on each link, PER CYCLE.
        --
        -- pipeline_cycle keeps totals, which cannot answer the question that
        -- matters: of the links that had none of our comments last time, how
        -- many have one now? That is a per-link comparison between two cycles,
        -- so each cycle keeps its own row per link.
        --
        -- Clusters are stored as they were AT SCAN TIME. They are relative and
        -- move when the pool changes, so reading them back later would report a
        -- link under a cluster it was not in when it was read.
        CREATE TABLE IF NOT EXISTS pipeline_scan (
          cycle_id     BIGINT NOT NULL,
          url          TEXT   NOT NULL,
          our_count    INT    NOT NULL DEFAULT 0,
          read_count   INT    NOT NULL DEFAULT 0,
          rank_cluster INT,
          date_cluster INT,
          PRIMARY KEY (cycle_id, url)
        );
        CREATE INDEX IF NOT EXISTS pipeline_scan_cycle ON pipeline_scan (cycle_id);
        -- Small named values that do not deserve a column of their own: a
        -- cursor into a long job, the summary of its last run. app_state is a
        -- single row of named columns, which is the wrong shape for anything
        -- that comes and goes with a feature.
        CREATE TABLE IF NOT EXISTS app_kv (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- One press of "Extract comments": what was scanned, when, and what it
        -- found. link_comment_scan only ever holds the LATEST answer per link,
        -- so without this every re-scan erased the number it replaced and there
        -- was no way to see whether our comments were spreading or not.
        --
        -- Runs are grouped by SCOPE — the cluster selection and filters that
        -- defined the set of links. Two scopes cover different links, so their
        -- numbers are not comparable and never share a line on the graph.
        CREATE TABLE IF NOT EXISTS link_scan_run (
          id            BIGSERIAL PRIMARY KEY,
          scope_key     TEXT NOT NULL,
          scope_label   TEXT NOT NULL,
          started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          -- Running totals, added to as each batch finishes, so a run that is
          -- stopped half way still reports what it actually read.
          links         INT NOT NULL DEFAULT 0,
          comments_read INT NOT NULL DEFAULT 0,
          ours          INT NOT NULL DEFAULT 0,
          links_with_ours INT NOT NULL DEFAULT 0,
          -- {"purifytext": 12, "humlexic": 3} — how many of each product.
          per_product   JSONB NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS link_scan_run_scope
          ON link_scan_run (scope_key, started_at DESC);
        -- Which links a run has already read. A press re-reads everything, so
        -- the ledger is per RUN rather than per link: it makes one run resumable
        -- across requests without making the next press skip anything.
        CREATE TABLE IF NOT EXISTS link_scan_event (
          run_id     BIGINT NOT NULL,
          url        TEXT NOT NULL,
          scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (run_id, url)
        );
        -- What a comment scan found on one link. Drives BOTH the serving
        -- order inside a cluster and the reply generator.
        CREATE TABLE IF NOT EXISTS link_comment_scan (
          url            TEXT PRIMARY KEY,
          scanned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          -- Comments we could read, and what TikTok claims exist.
          read_count     INT NOT NULL DEFAULT 0,
          total_count    INT,
          complete       BOOLEAN NOT NULL DEFAULT false,
          -- How many of OUR product comments are on the video, and how far up
          -- the highest one sits (0 = very top). NULL rank = none found.
          our_count      INT NOT NULL DEFAULT 0,
          best_rank      INT,
          -- The video's own top comment, kept even when unrelated to us: it is
          -- what the reply generator writes against.
          top_text       TEXT,
          top_user       TEXT,
          top_likes      INT
        );
        -- One of OUR product comments found on a link. Position and likes are
        -- the two things worth knowing: how visible it is, and how it landed.
        CREATE TABLE IF NOT EXISTS link_product_comment (
          url        TEXT NOT NULL,
          product    TEXT NOT NULL,
          rank       INT  NOT NULL,
          likes      INT  NOT NULL DEFAULT 0,
          username   TEXT,
          text       TEXT,
          PRIMARY KEY (url, product, rank)
        );
        CREATE INDEX IF NOT EXISTS link_product_comment_url ON link_product_comment (url);
        -- A reply we generated for a video's top comment, recommending one of
        -- our products in the context of what that comment actually says.
        CREATE TABLE IF NOT EXISTS comment_reply_draft (
          id           BIGSERIAL PRIMARY KEY,
          url          TEXT NOT NULL,
          top_text     TEXT NOT NULL,
          top_user     TEXT,
          product      TEXT NOT NULL,
          reply        TEXT NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          used         BOOLEAN NOT NULL DEFAULT false
        );
        CREATE INDEX IF NOT EXISTS comment_reply_draft_url ON comment_reply_draft (url);
        -- Top comments judged NOT about humanizers or AI detection. Recorded so
        -- they are never re-sent to the model: without this every run would pay
        -- for the same verdict again on the same thousands of comments.
        CREATE TABLE IF NOT EXISTS comment_reply_skip (
          url        TEXT PRIMARY KEY,
          top_text   TEXT,
          reason     TEXT NOT NULL DEFAULT 'unrelated',
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS link_category (
          url        TEXT PRIMARY KEY,
          category   TEXT NOT NULL,
          decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- A channel's bio, keyed by handle. verify_link stores the bio per LINK,
        -- but merging into the pool drops it, so a merged link has no bio to be
        -- categorised from. A bio describes the CHANNEL, so one row per handle
        -- serves every link that channel ever posts.
        CREATE TABLE IF NOT EXISTS channel_bio (
          handle     TEXT PRIMARY KEY,
          bio        TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS link_stat (
          url         TEXT PRIMARY KEY,
          heart_count BIGINT,
          view_count  BIGINT,
          fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- TikTok photo-mode posts (image carousels) are served under /video/<id>
        -- in search results and only become /photo/<id> in the browser, so the
        -- URL cannot identify them. The counts refresh reads it for free.
        ALTER TABLE link_stat ADD COLUMN IF NOT EXISTS is_photo BOOLEAN;
      `)
      .then(() => undefined)
      .catch((e) => {
        // Reset so a transient failure can be retried on the next call.
        ensured = null
        throw e
      })
  }
  return ensured
}

export async function getClickedUrls(userId: string): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    'SELECT url FROM clicked_link WHERE user_id = $1',
    [userId]
  )
  return rows.map((r) => r.url)
}

export interface UserClick {
  url: string
  platform: string | null
  search_query: string | null
  clicked_at: string
}

// ── TikTok comment verification (weekly validity) ────────────────────────────
// A local Playwright checker opens each user's submitted TikTok sample link,
// reads the comments, and if the user's own @username is present marks them
// valid for 7 days. Validity is stored here; the dashboard shows the badge.
let ensuredValidity: Promise<void> | null = null

export function ensureValidityTable(): Promise<void> {
  if (!ensuredValidity) {
    ensuredValidity = pool
      .query(`
        CREATE TABLE IF NOT EXISTS user_validity (
          user_id     TEXT PRIMARY KEY,
          valid_until TIMESTAMPTZ,
          checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredValidity = null
        throw e
      })
  }
  return ensuredValidity
}

// Mark a user valid for `days` from now (the check day). Used when the checker
// finds the user's username among a sample video's comments.
export async function setUserValid(userId: string, days: number): Promise<void> {
  await ensureValidityTable()
  await pool.query(
    `INSERT INTO user_validity (user_id, valid_until, checked_at)
     VALUES ($1, now() + ($2::text || ' days')::interval, now())
     ON CONFLICT (user_id) DO UPDATE SET
       valid_until = now() + ($2::text || ' days')::interval,
       checked_at  = now()`,
    [userId, String(Math.max(1, Math.floor(days)))]
  )
}

// Mark a user UNVERIFIED after a check that did NOT find their account. We KEEP a
// row (valid_until = NULL, checked_at = now) rather than deleting it, so the
// dashboard can tell "checked but account not found" (→ ⚠ warning) apart from
// "never checked yet".
export async function clearUserValidity(userId: string): Promise<void> {
  await ensureValidityTable()
  await pool.query(
    `INSERT INTO user_validity (user_id, valid_until, checked_at)
     VALUES ($1, NULL, now())
     ON CONFLICT (user_id) DO UPDATE SET valid_until = NULL, checked_at = now()`,
    [userId]
  )
}

// Fully remove a user's validity row (back to the "never checked" state).
export async function deleteUserValidity(userId: string): Promise<void> {
  await ensureValidityTable()
  await pool.query('DELETE FROM user_validity WHERE user_id = $1', [userId])
}

/**
 * Can this user work yet?
 *
 * True once a check has found their TikTok username among the verification
 * video's commenters and that result has not expired. Everyone else is held at
 * the gate — this is the single source of truth for it, used by the web
 * dashboard, the app's link feed and both click endpoints.
 */
export async function isUserVerified(userId: string): Promise<boolean> {
  await ensureValidityTable()
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT (valid_until IS NOT NULL AND valid_until > now()) AS ok
       FROM user_validity WHERE user_id = $1`,
    [userId]
  )
  return rows[0]?.ok === true
}

/** validUntil + checkedAt for one user, for the "we checked and…" message. */
export async function getUserValidity(
  userId: string
): Promise<{ validUntil: string | null; checkedAt: string | null }> {
  await ensureValidityTable()
  const { rows } = await pool.query<{ valid_until: string | null; checked_at: string | null }>(
    'SELECT valid_until, checked_at FROM user_validity WHERE user_id = $1',
    [userId]
  )
  const r = rows[0]
  return {
    validUntil: r?.valid_until ? new Date(r.valid_until).toISOString() : null,
    checkedAt: r?.checked_at ? new Date(r.checked_at).toISOString() : null,
  }
}

// user_id → { validUntil (ISO or null), checkedAt (ISO) } for everyone who has a
// validity row. A row with validUntil === null means "checked, account not found".
export async function getAllUserValidity(): Promise<
  Record<string, { validUntil: string | null; checkedAt: string | null }>
> {
  await ensureValidityTable()
  const { rows } = await pool.query<{ user_id: string; valid_until: Date | null; checked_at: Date | null }>(
    'SELECT user_id, valid_until, checked_at FROM user_validity'
  )
  const out: Record<string, { validUntil: string | null; checkedAt: string | null }> = {}
  for (const r of rows)
    out[r.user_id] = {
      validUntil: r.valid_until ? new Date(r.valid_until).toISOString() : null,
      checkedAt: r.checked_at ? new Date(r.checked_at).toISOString() : null,
    }
  return out
}

// The list the local checker pulls: each user's TikTok profile URL plus the
// TikTok sample links they submitted while reporting (last 14 days). The API
// route derives the @username from tiktok_url.
export async function getTiktokVerifyList(): Promise<
  { userId: string; name: string; tiktokUrl: string; sampleUrls: string[] }[]
> {
  await Promise.all([ensureUserProfileTable(), ensureClickedTable()])
  const { rows } = await pool.query<{
    user_id: string; tiktok_url: string; sample_urls: string[] | null
    profile_name: string | null; auth_name: string | null; email: string | null
  }>(
    `SELECT p.user_id, p.tiktok_url, p.name AS profile_name, u.name AS auth_name, u.email,
            array_agg(DISTINCT cs.sample_url)
              FILTER (WHERE cs.sample_url IS NOT NULL AND cs.sample_url <> ''
                        AND cs.sample_url ILIKE '%tiktok.com%') AS sample_urls
       FROM user_profile p
       LEFT JOIN "user" u ON u.id = p.user_id
       LEFT JOIN commented_submission cs
              ON cs.user_id = p.user_id
             AND cs.platform = 'tiktok'
             AND cs.submitted_at >= now() - interval '14 days'
      WHERE p.tiktok_url IS NOT NULL AND p.tiktok_url <> ''
      GROUP BY p.user_id, p.tiktok_url, p.name, u.name, u.email`
  )
  return rows
    .map((r) => ({
      userId: r.user_id,
      name: r.profile_name || r.auth_name || r.email || '',
      tiktokUrl: r.tiktok_url,
      sampleUrls: r.sample_urls ?? [],
    }))
    .filter((r) => r.sampleUrls.length > 0)
}

// Every link a user has clicked (opened), newest first — for the admin viewer.
export async function getUserClicks(userId: string): Promise<UserClick[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{
    url: string
    platform: string | null
    search_query: string | null
    clicked_at: Date
  }>(
    `SELECT url, platform, search_query, clicked_at
       FROM clicked_link
      WHERE user_id = $1
      ORDER BY clicked_at DESC`,
    [userId]
  )
  return rows.map((r) => ({
    url: r.url,
    platform: r.platform,
    search_query: r.search_query,
    clicked_at: r.clicked_at ? new Date(r.clicked_at).toISOString() : '',
  }))
}

// Remove EVERY click this user made — each link they clicked regains one click of
// quota (its distinct-user count drops by one). Used to undo an unverified user's
// clicks so their (unverified) engagement doesn't retire links. Returns rows removed.
export async function removeAllUserClicks(userId: string): Promise<number> {
  await ensureClickedTable()
  const { rowCount } = await pool.query('DELETE FROM clicked_link WHERE user_id = $1', [userId])
  return rowCount ?? 0
}

// ── Verify-links staging list ────────────────────────────────────────────────
// Channel-scraped links (from scrape_channels.py) that must be verified before
// they join the main pool. Independent of videos.json. Has no search rank — when
// merged they cluster by posted date only (date_only flag on the merged rows).
let ensuredVerifyLinks: Promise<void> | null = null

export function ensureVerifyLinkTable(): Promise<void> {
  if (!ensuredVerifyLinks) {
    ensuredVerifyLinks = pool
      .query(`
        CREATE TABLE IF NOT EXISTS verify_link (
          url           TEXT PRIMARY KEY,
          account       TEXT,
          platform      TEXT NOT NULL DEFAULT 'tiktok',
          view_count    BIGINT DEFAULT 0,
          heart_count   BIGINT DEFAULT 0,
          comment_count BIGINT DEFAULT 0,
          share_count   BIGINT DEFAULT 0,
          posted_date   TEXT,
          title         TEXT,
          -- The CHANNEL's bio, stamped on each of its links by the scraper. Shown
          -- in the verify table so a link can be judged without opening it.
          bio           TEXT,
          added_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE verify_link ADD COLUMN IF NOT EXISTS bio TEXT;
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredVerifyLinks = null
        throw e
      })
  }
  return ensuredVerifyLinks
}

export interface VerifyLinkRow {
  url: string
  account: string | null
  platform: string
  view_count: number
  heart_count: number
  comment_count: number
  share_count: number
  posted_date: string | null
  title: string | null
  bio: string | null
}

type RawVerifyRow = {
  url?: unknown; account?: unknown; view_count?: unknown; heart_count?: unknown
  comment_count?: unknown; share_count?: unknown; posted_date?: unknown; title?: unknown
  bio?: unknown
}

// Bulk upsert uploaded rows (the client sends chunks). Returns rows written.
// Upsert channel-scraped links into the verify staging list. A URL that is
// already staged is UPDATED rather than inserted twice: its view/heart/comment/
// share counts are refreshed from the new upload, but only with a valid positive
// value — a scrape that momentarily returned 0 (or a blank title/date) never
// wipes a real value already stored.
export async function saveVerifyLinks(rows: RawVerifyRow[]): Promise<number> {
  const clean = rows
    .map((r) => ({
      url: String(r?.url ?? '').trim(),
      account: r?.account != null ? String(r.account).slice(0, 120) : null,
      view_count: Number(r?.view_count) || 0,
      heart_count: Number(r?.heart_count) || 0,
      comment_count: Number(r?.comment_count) || 0,
      share_count: Number(r?.share_count) || 0,
      posted_date: r?.posted_date != null ? String(r.posted_date).slice(0, 60) : null,
      title: r?.title != null ? String(r.title).slice(0, 500) : null,
      bio: r?.bio != null ? String(r.bio).slice(0, 500) : null,
    }))
    .filter((r) => r.url.startsWith('http'))
  if (clean.length === 0) return 0
  await ensureVerifyLinkTable()
  const { rowCount } = await pool.query(
    `INSERT INTO verify_link (url, account, platform, view_count, heart_count, comment_count, share_count, posted_date, title, bio)
     SELECT * FROM unnest($1::text[], $2::text[], $10::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::bigint[], $7::text[], $8::text[], $9::text[])
     ON CONFLICT (url) DO UPDATE SET
       account       = COALESCE(NULLIF(EXCLUDED.account, ''), verify_link.account),
       platform      = EXCLUDED.platform,
       view_count    = CASE WHEN EXCLUDED.view_count    > 0 THEN EXCLUDED.view_count    ELSE verify_link.view_count    END,
       heart_count   = CASE WHEN EXCLUDED.heart_count   > 0 THEN EXCLUDED.heart_count   ELSE verify_link.heart_count   END,
       comment_count = CASE WHEN EXCLUDED.comment_count > 0 THEN EXCLUDED.comment_count ELSE verify_link.comment_count END,
       share_count   = CASE WHEN EXCLUDED.share_count   > 0 THEN EXCLUDED.share_count   ELSE verify_link.share_count   END,
       posted_date   = COALESCE(NULLIF(EXCLUDED.posted_date, ''), verify_link.posted_date),
       title         = COALESCE(NULLIF(EXCLUDED.title, ''), verify_link.title),
       bio           = COALESCE(NULLIF(EXCLUDED.bio, ''), verify_link.bio)`,
    [
      clean.map((r) => r.url), clean.map((r) => r.account),
      clean.map((r) => r.view_count), clean.map((r) => r.heart_count),
      clean.map((r) => r.comment_count), clean.map((r) => r.share_count),
      clean.map((r) => r.posted_date), clean.map((r) => r.title),
      clean.map((r) => r.bio),
      clean.map((r) => platformFromUrl(r.url)),
    ]
  )
  return rowCount ?? 0
}

function mapVerifyRow(r: Record<string, unknown>): VerifyLinkRow {
  return {
    url: String(r.url),
    account: r.account != null ? String(r.account) : null,
    platform: String(r.platform ?? 'tiktok'),
    view_count: Number(r.view_count) || 0,
    heart_count: Number(r.heart_count) || 0,
    comment_count: Number(r.comment_count) || 0,
    share_count: Number(r.share_count) || 0,
    posted_date: r.posted_date != null ? String(r.posted_date) : null,
    title: r.title != null ? String(r.title) : null,
    bio: r.bio != null ? String(r.bio) : null,
  }
}

// Whether a page of verify links is restricted by title presence.
//   'all'  — every link
//   'has'  — only links that have a title (filters OUT the untitled ones)
//   'none' — only links with no title yet
export type TitleFilter = 'all' | 'has' | 'none'

// Build the WHERE predicate for a page of verify links, plus its parameters.
//
// A "title" counts as present only when it is non-null AND not blank, so CSV rows
// with an empty title column read as untitled rather than titled-with-''. The
// channel filter is matched case-insensitively and de-duplicated, mirroring the
// channel picker that produces it.
//
// Returned as a bare predicate (not "WHERE …") because the count query embeds it
// inside COUNT(*) FILTER (WHERE …).
/**
 * The platform of a verify row, IN SQL, read from its URL.
 *
 * Deliberately not the stored `platform` column. That column is whatever the
 * uploader or scraper put there, and it has been wrong before — 504 pool rows
 * were Instagram links labelled tiktok, which is how Instagram links ended up
 * in the rank clusters. The URL is the only thing that cannot be mislabelled.
 *
 * Mirrors platformFromUrl() in lib/config.ts, rule for rule, including
 * "anything unrecognised is tiktok" — so the filter buckets a row exactly where
 * the rest of the app does.
 */
const VERIFY_PLATFORM_SQL = `
  CASE
    WHEN lower(url) LIKE '%instagram.com%' THEN 'instagram'
    WHEN lower(url) LIKE '%youtube.com%' OR lower(url) LIKE '%youtu.be%'
      THEN CASE WHEN lower(url) LIKE '%/shorts/%' THEN 'youtube_shorts'
                ELSE 'youtube_videos' END
    ELSE 'tiktok'
  END`

function verifyWhere(
  filter: TitleFilter,
  accounts: string[],
  platform = ''
): { predicate: string; params: unknown[] } {
  const conds: string[] = []
  const params: unknown[] = []
  if (filter === 'has') conds.push("title IS NOT NULL AND btrim(title) <> ''")
  else if (filter === 'none') conds.push("(title IS NULL OR btrim(title) = '')")

  const plat = String(platform ?? '').trim()
  if (plat) {
    params.push(plat)
    conds.push(`${VERIFY_PLATFORM_SQL} = $${params.length}`)
  }

  const accs = Array.from(
    new Set(accounts.map((a) => String(a ?? '').trim().toLowerCase()).filter(Boolean))
  )
  if (accs.length > 0) {
    params.push(accs)
    conds.push(`lower(account) = ANY($${params.length}::text[])`)
  }
  return { predicate: conds.length ? conds.join(' AND ') : 'TRUE', params }
}

export async function getVerifyLinks(
  limit: number,
  offset: number,
  filter: TitleFilter = 'all',
  accounts: string[] = [],
  platform = ''
): Promise<{ rows: VerifyLinkRow[]; total: number; totalAll: number }> {
  await ensureVerifyLinkTable()
  const { predicate, params } = verifyWhere(filter, accounts, platform)
  const [pageRes, cntRes] = await Promise.all([
    pool.query(
      // GROUPED BY CHANNEL. A channel is judged as a whole — from its bio and
      // what it posts — so its links have to arrive together instead of being
      // interleaved with everyone else's by upload time.
      //
      // Channels are ordered by when their FIRST link was staged, not
      // alphabetically: that keeps the list in the order the uploads arrived,
      // which is the order the admin is working through, while still putting
      // each channel's links in one run. A channel wider than a page continues
      // onto the next one under the same heading.
      `SELECT url, account, platform, view_count, heart_count, comment_count, share_count, posted_date, title, bio
         FROM (
           SELECT *, min(added_at) OVER (PARTITION BY lower(coalesce(account, ''))) AS chan_first
             FROM verify_link WHERE ${predicate}
         ) t
        ORDER BY chan_first, lower(coalesce(account, '')), added_at, url
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    // One row per filter state: the filtered count drives the pager, the
    // unfiltered one keeps "Clean the WHOLE list" honest while a filter is on.
    pool.query<{ n: number; total_all: number }>(
      `SELECT (COUNT(*) FILTER (WHERE ${predicate}))::int AS n,
              COUNT(*)::int AS total_all
         FROM verify_link`,
      params
    ),
  ])
  const c = cntRes.rows[0]
  return { rows: pageRes.rows.map(mapVerifyRow), total: c?.n ?? 0, totalAll: c?.total_all ?? 0 }
}

export async function getVerifyLinksByUrls(urls: string[]): Promise<VerifyLinkRow[]> {
  if (urls.length === 0) return []
  await ensureVerifyLinkTable()
  const { rows } = await pool.query(
    `SELECT url, account, platform, view_count, heart_count, comment_count, share_count, posted_date, title, bio
       FROM verify_link WHERE url = ANY($1::text[])`,
    [urls]
  )
  return rows.map(mapVerifyRow)
}

/**
 * How many verify links each platform holds, by URL.
 *
 * Counted rather than assumed so the filter can show the numbers: a dropdown
 * offering Instagram when there are no Instagram links is a filter that
 * silently empties the page.
 */
export async function getVerifyPlatformCounts(): Promise<Record<string, number>> {
  await ensureVerifyLinkTable()
  const { rows } = await pool.query<{ p: string; n: number }>(
    `SELECT ${VERIFY_PLATFORM_SQL} AS p, COUNT(*)::int AS n FROM verify_link GROUP BY 1`
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.p] = r.n
  return out
}

/** Distinct channels in the verify list, with how many links each still has. */
export async function getVerifyAccounts(): Promise<{ account: string; platform: string; n: number }[]> {
  await ensureVerifyLinkTable()
  const { rows } = await pool.query<{ account: string; platform: string; n: number }>(
    `SELECT account, MIN(platform) AS platform, COUNT(*)::int AS n
       FROM verify_link
      WHERE account IS NOT NULL AND btrim(account) <> ''
      GROUP BY account
      ORDER BY n DESC, account`
  )
  return rows.map((r) => ({ account: r.account, platform: r.platform || 'tiktok', n: r.n }))
}

/** Every verify link belonging to one channel — the whole channel, not one page. */
export async function getVerifyLinksByAccount(account: string): Promise<VerifyLinkRow[]> {
  return getVerifyLinksByAccounts([account])
}

/**
 * Every verify link belonging to ANY of these channels, across all pages.
 *
 * One query for the whole selection rather than one per channel: merging a
 * search's worth of channels is the point of multi-select, and N round trips
 * would make a 40-channel merge crawl.
 */
export async function getVerifyLinksByAccounts(accounts: string[]): Promise<VerifyLinkRow[]> {
  const clean = Array.from(
    new Set(accounts.map((a) => String(a ?? '').trim().toLowerCase()).filter(Boolean))
  )
  if (clean.length === 0) return []
  await ensureVerifyLinkTable()
  const { rows } = await pool.query(
    `SELECT url, account, platform, view_count, heart_count, comment_count, share_count, posted_date, title, bio
       FROM verify_link WHERE lower(account) = ANY($1::text[])`,
    [clean]
  )
  return rows.map(mapVerifyRow)
}

export async function deleteVerifyLinks(urls: string[]): Promise<number> {
  if (urls.length === 0) return 0
  await ensureVerifyLinkTable()
  const { rowCount } = await pool.query('DELETE FROM verify_link WHERE url = ANY($1::text[])', [urls])
  return rowCount ?? 0
}

// Every URL currently in the verify-links staging list (lightweight — url only).
export async function getAllVerifyLinkUrls(): Promise<string[]> {
  await ensureVerifyLinkTable()
  const { rows } = await pool.query<{ url: string }>('SELECT url FROM verify_link')
  return rows.map((r) => r.url)
}

// Wipe the entire verify-links staging list. Returns how many rows were removed.
export async function clearVerifyLinks(): Promise<number> {
  await ensureVerifyLinkTable()
  const { rowCount } = await pool.query('DELETE FROM verify_link')
  return rowCount ?? 0
}

// ── Per-user state snapshots (taken when marking a user paid, before reset) ───
// A frozen copy of the user's admin row keyed by the day, so past states can be
// retrieved after payments reset the running counters.
let ensuredSnapshot: Promise<void> | null = null

export function ensureSnapshotTable(): Promise<void> {
  if (!ensuredSnapshot) {
    ensuredSnapshot = pool
      .query(`
        CREATE TABLE IF NOT EXISTS user_snapshot (
          id         BIGSERIAL PRIMARY KEY,
          user_id    TEXT NOT NULL,
          day        TEXT NOT NULL,
          snapshot   JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS user_snapshot_user_idx ON user_snapshot (user_id, created_at DESC);
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredSnapshot = null
        throw e
      })
  }
  return ensuredSnapshot
}

export async function saveUserSnapshot(userId: string, day: string, snapshot: unknown): Promise<number> {
  await ensureSnapshotTable()
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO user_snapshot (user_id, day, snapshot) VALUES ($1, $2, $3::jsonb) RETURNING id',
    [userId, day, JSON.stringify(snapshot)]
  )
  return rows[0]?.id ?? 0
}

// The most recent snapshot per user (for the admin list's "past states" label).
export async function getLatestSnapshotByUser(): Promise<Record<string, { day: string; created_at: string }>> {
  await ensureSnapshotTable()
  const { rows } = await pool.query<{ user_id: string; day: string; created_at: string }>(
    `SELECT DISTINCT ON (user_id) user_id, day, created_at::text AS created_at
     FROM user_snapshot ORDER BY user_id, created_at DESC`
  )
  const out: Record<string, { day: string; created_at: string }> = {}
  for (const r of rows) out[r.user_id] = { day: r.day, created_at: r.created_at }
  return out
}

// The saved snapshots for a user (newest first) — id, day, when.
export async function getUserSnapshots(userId: string): Promise<{ id: number; day: string; created_at: string }[]> {
  await ensureSnapshotTable()
  const { rows } = await pool.query<{ id: number; day: string; created_at: string }>(
    'SELECT id, day, created_at::text AS created_at FROM user_snapshot WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  )
  return rows.map((r) => ({ id: Number(r.id), day: r.day, created_at: r.created_at }))
}

export async function getUserSnapshot(id: number): Promise<{ day: string; created_at: string; snapshot: unknown } | null> {
  await ensureSnapshotTable()
  const { rows } = await pool.query<{ day: string; created_at: string; snapshot: unknown }>(
    'SELECT day, created_at::text AS created_at, snapshot FROM user_snapshot WHERE id = $1',
    [id]
  )
  const r = rows[0]
  return r ? { day: r.day, created_at: r.created_at, snapshot: r.snapshot } : null
}

// URLs that have been clicked by at least `threshold` distinct users. Because of
// the UNIQUE (user_id, url) constraint, one row per user, so COUNT(*) == distinct
// users. These are retired for everyone.
export async function getRetiredUrls(threshold: number): Promise<string[]> {
  if (threshold <= 0) return []
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    `SELECT url FROM clicked_link
     GROUP BY url
     HAVING COUNT(*) >= $1`,
    [threshold]
  )
  return rows.map((r) => r.url)
}

// Distinct-user click count per URL (one clicked_link row per user, so COUNT(*)
// == distinct users). Used by the admin links page to show each link's progress
// toward the retire-after-N-users quota and to list "finished" (retired) links.
export async function getClickCountsByUrl(): Promise<Record<string, number>> {
  await ensureClickedTable()
  // Exclude debug/admin accounts so their test clicks don't count toward the
  // retire quota (or the admin "clicked by" count).
  const { rows } = await pool.query<{ url: string; n: number }>(
    `SELECT cl.url, COUNT(*)::int AS n
       FROM clicked_link cl
      WHERE cl.user_id NOT IN (
              SELECT id FROM "user" WHERE lower(email) = ANY($1::text[])
            )
      GROUP BY cl.url`,
    [CLICK_EXCLUDED_EMAILS]
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.url] = r.n
  return out
}

// ── One-time backfill: stamp `product` on clicks recorded before the column ──
// Pre-existing rows have no product. This attributes them to whatever product the
// user was assigned to at backfill time — the click-time product wasn't recorded
// back then, and the old JOIN-based query assumed the same thing, so this
// preserves the historical numbers rather than changing them.
//
// It only ever touches rows that predate the `product` column. New clicks are
// stamped with the product whose COMMENT WAS SERVED (see recordClick); user↔product
// assignment no longer exists, so nothing new can land here un-stamped-and-fillable.
let backfilledClickProduct: Promise<void> | null = null

function backfillClickProducts(): Promise<void> {
  if (!backfilledClickProduct) {
    backfilledClickProduct = (async () => {
      // Instant thanks to the partial index; matches nothing after the first run.
      const { rowCount } = await pool.query('SELECT 1 FROM clicked_link WHERE product IS NULL LIMIT 1')
      if (!rowCount) return
      await pool.query(
        `UPDATE clicked_link cl
            SET product = up.product
           FROM user_product up
          WHERE cl.product IS NULL AND up.user_id = cl.user_id`
      )
    })().catch((e) => {
      backfilledClickProduct = null // let a later request retry
      throw e
    })
  }
  return backfilledClickProduct
}

// Distinct-user click count per URL, scoped to ONE product — only clicks that
// were MADE FOR `product` count (the stamp on the row, not the clicker's current
// assignment). Retirement is computed per product, so a link retired for one
// product's users stays available to another's, and each product's tally moves
// only when someone clicks for that product.
export async function getClickCountsByUrlForProduct(
  product: string | null
): Promise<Record<string, number>> {
  // No product assigned (legacy user) → fall back to the global count.
  if (!product) return getClickCountsByUrl()
  await Promise.all([ensureClickedTable(), ensureAdminTables()])
  await backfillClickProducts().catch(() => {})
  // Counted on the click's OWN product stamp, so each product's tally is
  // independent and unaffected by users being reassigned later.
  const { rows } = await pool.query<{ url: string; n: number }>(
    `SELECT cl.url, COUNT(*)::int AS n
       FROM clicked_link cl
      WHERE cl.product = $1
        AND cl.user_id NOT IN (SELECT id FROM "user" WHERE lower(email) = ANY($2::text[]))
      GROUP BY cl.url`,
    [product, CLICK_EXCLUDED_EMAILS]
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.url] = r.n
  return out
}

// Distinct-user click counts per URL, grouped by product — { product: { url: n } }.
// Used by the admin links page so retirement can be inspected per product.
export async function getClickCountsByProductAndUrl(): Promise<Record<string, Record<string, number>>> {
  await Promise.all([ensureClickedTable(), ensureAdminTables()])
  await backfillClickProducts().catch(() => {})
  const { rows } = await pool.query<{ product: string; url: string; n: number }>(
    `SELECT cl.product, cl.url, COUNT(*)::int AS n
       FROM clicked_link cl
      WHERE cl.product IS NOT NULL
        AND cl.user_id NOT IN (SELECT id FROM "user" WHERE lower(email) = ANY($1::text[]))
      GROUP BY cl.product, cl.url`,
    [CLICK_EXCLUDED_EMAILS]
  )
  const out: Record<string, Record<string, number>> = {}
  for (const r of rows) (out[r.product] ??= {})[r.url] = r.n
  return out
}

// ── "Unrelated to humanizers" flags ──────────────────────────────────────────
// Recorded when a user hits the "not related" button on a link. Does NOT count
// toward the click/retire quota, but hides the link from that user.
export async function addUnrelatedLink(userId: string, url: string, platform: string | null): Promise<void> {
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO unrelated_link (user_id, url, platform) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, url) DO NOTHING`,
    [userId, url, platform]
  )
}

// Drop this user's click on a link (used when they mark it unrelated after
// opening it, so that click no longer counts toward the hourly/retire quota).
// The link stays hidden from them via the unrelated flag.
export async function removeUserClick(userId: string, url: string): Promise<void> {
  await ensureClickedTable()
  await pool.query('DELETE FROM clicked_link WHERE user_id = $1 AND url = $2', [userId, url])
}

// URLs this user flagged as unrelated (so we can hide them from that user).
export async function getUnrelatedUrls(userId: string): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    'SELECT url FROM unrelated_link WHERE user_id = $1',
    [userId]
  )
  return rows.map((r) => r.url)
}

// Admin: clear every "unrelated" flag on a URL (the link is actually fine).
// Returns how many flags were removed.
export async function clearUnrelatedLink(url: string): Promise<number> {
  await ensureClickedTable()
  const { rowCount } = await pool.query('DELETE FROM unrelated_link WHERE url = $1', [url])
  return rowCount ?? 0
}

// ── Permanent block list ─────────────────────────────────────────────────────
// Admin: block a URL forever. It's filtered out of every user's list at serve
// time, so re-uploading videos.json can never bring it back. Not a delete.
export async function blockLink(url: string): Promise<void> {
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO blocked_link (url) VALUES ($1) ON CONFLICT (url) DO NOTHING`,
    [url]
  )
}

// Admin: block many URLs at once (bulk "block all filtered"). Also clears any
// unrelated flags on them. Returns how many new blocks were added.
export async function blockLinks(urls: string[]): Promise<number> {
  const clean = urls.map((u) => String(u).trim()).filter(Boolean)
  if (clean.length === 0) return 0
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    `INSERT INTO blocked_link (url) SELECT unnest($1::text[]) ON CONFLICT (url) DO NOTHING`,
    [clean]
  )
  await pool.query('DELETE FROM unrelated_link WHERE url = ANY($1::text[])', [clean]).catch(() => {})
  return rowCount ?? 0
}

// Admin: lift a permanent block (the link may appear again if it's in the pool).
export async function unblockLink(url: string): Promise<number> {
  await ensureClickedTable()
  const { rowCount } = await pool.query('DELETE FROM blocked_link WHERE url = $1', [url])
  return rowCount ?? 0
}

// ── Link comment scans ───────────────────────────────────────────────────────

export interface LinkScanRow {
  url: string
  scannedAt: string
  readCount: number
  totalCount: number | null
  complete: boolean
  ourCount: number
  bestRank: number | null
  topText: string | null
  topUser: string | null
  topLikes: number | null
  /** Products already present on the link, from link_product_comment. */
  products: string[]
}

/**
 * Every URL the comment extraction has looked at.
 *
 * Needed to tell "we read this and found none of ours" apart from "nobody has
 * looked". A clean link writes NO link_product_comment rows, so the product
 * counts alone cannot distinguish the two — and 2,395 links were being reported
 * as unexamined when they had in fact been read and found clean.
 */
export interface ScanCoverage {
  /** Comments the extraction actually read. */
  read: number
  /** Comments TikTok claims the video has. Counts REPLIES, which the list
   *  endpoint never returns, so it can exceed `read` on a finished scan. */
  total: number | null
  /** TikTok said there was no more AND we hold as many as it claims. */
  complete: boolean
}

export async function getScanCoverage(): Promise<Record<string, ScanCoverage>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{
    url: string
    read_count: number
    total_count: number | null
    complete: boolean
  }>('SELECT url, read_count, total_count, complete FROM link_comment_scan')
  const out: Record<string, ScanCoverage> = {}
  for (const r of rows) {
    out[r.url] = { read: r.read_count, total: r.total_count, complete: r.complete }
  }
  return out
}

// ── Scan runs ────────────────────────────────────────────────────────────────

export interface ScanRun {
  id: number
  scopeKey: string
  scopeLabel: string
  startedAt: string
  updatedAt: string
  links: number
  commentsRead: number
  ours: number
  linksWithOurs: number
  perProduct: Record<string, number>
}

/** Open a new run. One per press of the button. */
export async function startScanRun(scopeKey: string, scopeLabel: string): Promise<number> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO link_scan_run (scope_key, scope_label) VALUES ($1, $2) RETURNING id',
    [scopeKey.slice(0, 300), scopeLabel.slice(0, 300)]
  )
  return Number(rows[0].id)
}

/** URLs this RUN has already read, so it can resume without re-reading them. */
export async function getScanRunUrls(runId: number): Promise<Set<string>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    'SELECT url FROM link_scan_event WHERE run_id = $1',
    [runId]
  )
  return new Set(rows.map((r) => r.url))
}

/**
 * Fold one batch of results into a run.
 *
 * The per-product totals are merged IN SQL rather than read-modify-written here,
 * so two requests landing together cannot lose each other's counts.
 */
export async function recordScanRunBatch(
  runId: number,
  rows: { url: string; readCount: number; ourCount: number; products: Record<string, number> }[]
): Promise<void> {
  if (rows.length === 0) return
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO link_scan_event (run_id, url)
     SELECT $1, u FROM unnest($2::text[]) AS u
     ON CONFLICT (run_id, url) DO NOTHING`,
    [runId, rows.map((r) => r.url)]
  )
  const perProduct: Record<string, number> = {}
  for (const r of rows) {
    for (const [p, n] of Object.entries(r.products)) perProduct[p] = (perProduct[p] ?? 0) + n
  }
  await pool.query(
    `UPDATE link_scan_run
        SET links           = links + $2,
            comments_read   = comments_read + $3,
            ours            = ours + $4,
            links_with_ours = links_with_ours + $5,
            per_product = COALESCE((
              SELECT jsonb_object_agg(k, v)
                FROM (
                  SELECT k, SUM(v)::int AS v FROM (
                    SELECT key AS k, value::int AS v FROM jsonb_each_text(per_product)
                    UNION ALL
                    SELECT key, value::int FROM jsonb_each_text($6::jsonb)
                  ) parts GROUP BY k
                ) merged
            ), '{}'::jsonb),
            updated_at = now()
      WHERE id = $1`,
    [
      runId,
      rows.length,
      rows.reduce((a, r) => a + r.readCount, 0),
      rows.reduce((a, r) => a + r.ourCount, 0),
      rows.filter((r) => r.ourCount > 0).length,
      JSON.stringify(perProduct),
    ]
  )
}

/**
 * Every run, newest first, for the history modal.
 *
 * Runs that read nothing are dropped: a press that was stopped immediately, or
 * one whose links were all unresolvable, is not a data point — plotting it would
 * put a zero in the trend that says nothing about the videos.
 */
export async function getScanRuns(limit = 200): Promise<ScanRun[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{
    id: string
    scope_key: string
    scope_label: string
    started_at: Date
    updated_at: Date
    links: number
    comments_read: number
    ours: number
    links_with_ours: number
    per_product: Record<string, number> | null
  }>(
    `SELECT id, scope_key, scope_label, started_at, updated_at,
            links, comments_read, ours, links_with_ours, per_product
       FROM link_scan_run
      WHERE links > 0
      ORDER BY started_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(1000, limit))]
  )
  return rows.map((r) => ({
    id: Number(r.id),
    scopeKey: r.scope_key,
    scopeLabel: r.scope_label,
    startedAt: r.started_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    links: r.links,
    commentsRead: r.comments_read,
    ours: r.ours,
    linksWithOurs: r.links_with_ours,
    perProduct: r.per_product ?? {},
  }))
}

/** URLs already scanned, so a resumed pass skips them. */
export async function getScannedUrls(urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set()
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    'SELECT url FROM link_comment_scan WHERE url = ANY($1::text[])',
    [urls]
  )
  return new Set(rows.map((r) => r.url))
}

/** Store one link's scan plus the product comments found on it. */
export async function saveLinkScan(scan: {
  url: string
  readCount: number
  totalCount: number | null
  complete: boolean
  ourCount: number
  bestRank: number | null
  topText: string | null
  topUser: string | null
  topLikes: number | null
  hits: { product: string; rank: number; likes: number; username: string; text: string }[]
}): Promise<void> {
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO link_comment_scan
       (url, scanned_at, read_count, total_count, complete, our_count, best_rank,
        top_text, top_user, top_likes)
     VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (url) DO UPDATE SET
       scanned_at = now(), read_count = EXCLUDED.read_count,
       total_count = EXCLUDED.total_count, complete = EXCLUDED.complete,
       our_count = EXCLUDED.our_count, best_rank = EXCLUDED.best_rank,
       top_text = EXCLUDED.top_text, top_user = EXCLUDED.top_user,
       top_likes = EXCLUDED.top_likes`,
    [scan.url, scan.readCount, scan.totalCount, scan.complete, scan.ourCount,
     scan.bestRank, scan.topText, scan.topUser, scan.topLikes]
  )
  // Replaced wholesale: a re-scan is the newer truth about what is on the video,
  // and merging would keep comments that have since been deleted.
  await pool.query('DELETE FROM link_product_comment WHERE url = $1', [scan.url])
  if (scan.hits.length > 0) {
    await pool.query(
      `INSERT INTO link_product_comment (url, product, rank, likes, username, text)
       SELECT $1, p, r, l, u, t
         FROM unnest($2::text[], $3::int[], $4::int[], $5::text[], $6::text[])
              AS x(p, r, l, u, t)
       ON CONFLICT (url, product, rank) DO UPDATE SET
         likes = EXCLUDED.likes, username = EXCLUDED.username, text = EXCLUDED.text`,
      [scan.url, scan.hits.map((h) => h.product), scan.hits.map((h) => h.rank),
       scan.hits.map((h) => h.likes), scan.hits.map((h) => h.username),
       scan.hits.map((h) => h.text.slice(0, 300))]
    )
  }
}

/** Scan rows for a set of URLs, with the products present on each. */
export async function getLinkScans(urls: string[]): Promise<Record<string, LinkScanRow>> {
  if (urls.length === 0) return {}
  await ensureClickedTable()
  const { rows } = await pool.query<{
    url: string; scanned_at: Date; read_count: number; total_count: number | null
    complete: boolean; our_count: number; best_rank: number | null
    top_text: string | null; top_user: string | null; top_likes: number | null
    products: string[] | null
  }>(
    `SELECT s.url, s.scanned_at, s.read_count, s.total_count, s.complete,
            s.our_count, s.best_rank, s.top_text, s.top_user, s.top_likes,
            array_agg(DISTINCT c.product) FILTER (WHERE c.product IS NOT NULL) AS products
       FROM link_comment_scan s
       LEFT JOIN link_product_comment c ON c.url = s.url
      WHERE s.url = ANY($1::text[])
      GROUP BY s.url, s.scanned_at, s.read_count, s.total_count, s.complete,
               s.our_count, s.best_rank, s.top_text, s.top_user, s.top_likes`,
    [urls]
  )
  const out: Record<string, LinkScanRow> = {}
  for (const r of rows) {
    out[r.url] = {
      url: r.url,
      scannedAt: r.scanned_at.toISOString(),
      readCount: r.read_count,
      totalCount: r.total_count,
      complete: r.complete,
      ourCount: r.our_count,
      bestRank: r.best_rank,
      topText: r.top_text,
      topUser: r.top_user,
      topLikes: r.top_likes,
      products: r.products ?? [],
    }
  }
  return out
}

/**
 * Scanned links whose top comment has neither a reply draft nor a skip verdict.
 *
 * Both exclusions matter: a link with a draft is done, and a link already judged
 * unrelated must not be re-judged — that is the difference between one pass over
 * the backlog and paying for the same verdicts on every run.
 */
export async function getLinksNeedingReplies(
  limit: number
): Promise<{ url: string; topText: string; topUser: string | null }[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; top_text: string; top_user: string | null }>(
    `SELECT s.url, s.top_text, s.top_user
       FROM link_comment_scan s
      WHERE COALESCE(s.top_text, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM comment_reply_draft d WHERE d.url = s.url)
        AND NOT EXISTS (SELECT 1 FROM comment_reply_skip k WHERE k.url = s.url)
      ORDER BY s.top_likes DESC NULLS LAST
      LIMIT $1`,
    [Math.max(1, Math.min(500, limit))]
  )
  return rows.map((r) => ({ url: r.url, topText: r.top_text, topUser: r.top_user }))
}

/** Record top comments that are not about humanizers or AI detection. */
export async function saveReplySkips(
  rows: { url: string; topText: string }[]
): Promise<number> {
  if (rows.length === 0) return 0
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    `INSERT INTO comment_reply_skip (url, top_text)
     SELECT u, t FROM unnest($1::text[], $2::text[]) AS x(u, t)
     ON CONFLICT (url) DO NOTHING`,
    [rows.map((r) => r.url), rows.map((r) => r.topText.slice(0, 500))]
  )
  return rowCount ?? 0
}

export async function countReplySkips(): Promise<number> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM comment_reply_skip')
  return Number(rows[0]?.n ?? 0)
}

/** Forget every skip verdict, so unrelated comments are judged again. */
export async function clearReplySkips(): Promise<number> {
  await ensureClickedTable()
  const { rowCount } = await pool.query('DELETE FROM comment_reply_skip')
  return rowCount ?? 0
}

export async function saveReplyDrafts(
  drafts: { url: string; topText: string; topUser: string | null; product: string; reply: string }[]
): Promise<number> {
  if (drafts.length === 0) return 0
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    `INSERT INTO comment_reply_draft (url, top_text, top_user, product, reply)
     SELECT u, t, tu, p, r
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
            AS x(u, t, tu, p, r)`,
    [drafts.map((d) => d.url), drafts.map((d) => d.topText.slice(0, 500)),
     drafts.map((d) => d.topUser ?? ''), drafts.map((d) => d.product),
     drafts.map((d) => d.reply.slice(0, 500))]
  )
  return rowCount ?? 0
}

export interface ReplyDraftRow {
  id: number
  url: string
  topText: string
  topUser: string | null
  product: string
  reply: string
  createdAt: string
  used: boolean
  /** Comments TikTok reports on the link, and how many the scan could read. */
  commentTotal: number | null
  commentRead: number | null
}

export async function getReplyDrafts(opts: {
  offset: number
  limit: number
  q?: string
}): Promise<{ rows: ReplyDraftRow[]; matched: number }> {
  await ensureClickedTable()
  const q = (opts.q ?? '').trim()
  const where = q ? `WHERE d.top_text ILIKE $1 OR d.reply ILIKE $1 OR d.url ILIKE $1` : ''
  const params: unknown[] = q ? [`%${q}%`] : []
  const { rows: cnt } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM comment_reply_draft d ${where}`,
    params
  )
  const { rows } = await pool.query<{
    id: string; url: string; top_text: string; top_user: string | null
    product: string; reply: string; created_at: Date; used: boolean
    total_count: number | null; read_count: number | null
  }>(
    `SELECT d.id, d.url, d.top_text, d.top_user, d.product, d.reply, d.created_at, d.used,
            s.total_count, s.read_count
       FROM comment_reply_draft d
       LEFT JOIN link_comment_scan s ON s.url = d.url
       ${where}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, Math.max(1, Math.min(200, opts.limit)), Math.max(0, opts.offset)]
  )
  return {
    matched: Number(cnt[0]?.n ?? 0),
    rows: rows.map((r) => ({
      id: Number(r.id),
      url: r.url,
      topText: r.top_text,
      topUser: r.top_user,
      product: r.product,
      reply: r.reply,
      createdAt: r.created_at.toISOString(),
      used: r.used,
      commentTotal: r.total_count,
      commentRead: r.read_count,
    })),
  }
}

export async function setReplyUsed(id: number, used: boolean): Promise<void> {
  await ensureClickedTable()
  await pool.query('UPDATE comment_reply_draft SET used = $2 WHERE id = $1', [id, used])
}

// ── Comment presence ─────────────────────────────────────────────────────────

export interface PresenceDay {
  day: string
  checked: number
  found: number
  skipped: number
  pct: number | null
}

/**
 * SQL predicate excluding blocked users from a presence scan.
 *
 * blocked_user is keyed by EMAIL (and by bank / TikTok fingerprints), not by
 * user_id — a block has to survive someone signing up again — so the join goes
 * through the auth user's email. Scoring a blocked account would burn minutes of
 * TikTok reads on someone who cannot work anyway, and put a badge on a row the
 * admin has already dealt with.
 *
 * user_id is checked too: a block recorded before the email was known still
 * counts.
 */
const NOT_BLOCKED = `
  NOT EXISTS (
    SELECT 1 FROM blocked_user b
     WHERE (b.email IS NOT NULL AND b.email = lower(au.email))
        OR (b.user_id IS NOT NULL AND b.user_id = c.user_id)
  )`

/** TikTok links a user opened on one day (UTC), newest first. */
export async function getClickedOnDay(userId: string, day: string): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    `SELECT url FROM clicked_link
      WHERE user_id = $1 AND clicked_at::date = $2::date AND url ILIKE '%tiktok.com%'
      -- url breaks ties so the order is identical on every call. The day cap
      -- picks links by position, and a wobbling order would pick a different
      -- hundred each pass and defeat the resume ledger.
      ORDER BY clicked_at DESC, url`,
    [userId, day]
  )
  return rows.map((r) => r.url)
}

/** Users who opened at least one TikTok link on `day`, with their profile handle. */
export async function getClickersOnDay(
  day: string
): Promise<{ userId: string; tiktokUrl: string; clicks: number }[]> {
  await Promise.all([ensureClickedTable(), ensureUserProfileTable(), ensureBlockedUserTable()])
  const { rows } = await pool.query<{ user_id: string; tiktok_url: string; n: string }>(
    `SELECT c.user_id, p.tiktok_url, count(*)::text AS n
       FROM clicked_link c
       JOIN user_profile p ON p.user_id = c.user_id
       JOIN "user" au ON au.id = c.user_id
      WHERE c.clicked_at::date = $1::date
        AND c.url ILIKE '%tiktok.com%'
        AND p.tiktok_url IS NOT NULL AND p.tiktok_url <> ''
        AND ${NOT_BLOCKED}
      GROUP BY c.user_id, p.tiktok_url
      ORDER BY count(*) DESC`,
    [day]
  )
  return rows.map((r) => ({ userId: r.user_id, tiktokUrl: r.tiktok_url, clicks: Number(r.n) }))
}

/**
 * Users active in the last `days` days, with the most recent day they clicked.
 *
 * The admin sweep scores each user against their LAST active day rather than
 * today: someone who worked on Monday and not since should still be scored on
 * Monday's links, not on an empty today.
 */
export async function getRecentClickers(
  days: number
): Promise<{ userId: string; tiktokUrl: string; lastDay: string; clicks: number }[]> {
  await Promise.all([ensureClickedTable(), ensureUserProfileTable(), ensureBlockedUserTable()])
  const { rows } = await pool.query<{
    user_id: string; tiktok_url: string; last_day: Date; n: string
  }>(
    `SELECT c.user_id, p.tiktok_url, max(c.clicked_at)::date AS last_day, count(*)::text AS n
       FROM clicked_link c
       JOIN user_profile p ON p.user_id = c.user_id
       JOIN "user" au ON au.id = c.user_id
      WHERE c.clicked_at >= now() - ($1::int || ' days')::interval
        AND c.url ILIKE '%tiktok.com%'
        AND p.tiktok_url IS NOT NULL AND p.tiktok_url <> ''
        AND ${NOT_BLOCKED}
      GROUP BY c.user_id, p.tiktok_url
      ORDER BY max(c.clicked_at) DESC`,
    [days]
  )
  return rows.map((r) => ({
    userId: r.user_id,
    tiktokUrl: r.tiktok_url,
    lastDay: r.last_day.toISOString().slice(0, 10),
    clicks: Number(r.n),
  }))
}

// ── Pipeline cycles ──────────────────────────────────────────────────────────

export interface PipelineCycle {
  id: number
  startedAt: string
  finishedAt: string | null
  stages: Record<string, Record<string, unknown>>
}

/** Open a cycle. Returns its id, which the stages fold their totals into. */
export async function startPipelineCycle(): Promise<number> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO pipeline_cycle DEFAULT VALUES RETURNING id'
  )
  return Number(rows[0].id)
}

/**
 * Record what one stage did.
 *
 * Merged rather than replaced: a stage can take many ticks, and the last tick's
 * numbers alone would report a slice as though it were the whole stage. Counts
 * accumulate; everything else takes the newest value.
 */
export async function recordPipelineStage(
  cycleId: number,
  stage: string,
  summary: Record<string, unknown>,
  addCounts: string[] = []
): Promise<void> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ stages: Record<string, Record<string, unknown>> }>(
    'SELECT stages FROM pipeline_cycle WHERE id = $1',
    [cycleId]
  )
  const stages = rows[0]?.stages ?? {}
  const prev = stages[stage] ?? {}
  const next: Record<string, unknown> = { ...prev, ...summary }
  for (const k of addCounts) {
    const a = Number(prev[k])
    const b = Number(summary[k])
    if (Number.isFinite(b)) next[k] = (Number.isFinite(a) ? a : 0) + b
  }
  next.ticks = (Number(prev.ticks) || 0) + 1
  stages[stage] = next
  await pool.query('UPDATE pipeline_cycle SET stages = $2::jsonb WHERE id = $1', [
    cycleId,
    JSON.stringify(stages),
  ])
}

/** Close a cycle. */
export async function finishPipelineCycle(cycleId: number): Promise<void> {
  await ensureClickedTable()
  await pool.query('UPDATE pipeline_cycle SET finished_at = now() WHERE id = $1', [cycleId])
}

/** Record what the extract stage saw on these links this cycle. */
export async function savePipelineScans(
  cycleId: number,
  rows: { url: string; ourCount: number; readCount: number; rankCluster: number | null; dateCluster: number | null }[]
): Promise<void> {
  if (rows.length === 0) return
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO pipeline_scan (cycle_id, url, our_count, read_count, rank_cluster, date_cluster)
     SELECT $1, u, o, r, rc, dc
       FROM unnest($2::text[], $3::int[], $4::int[], $5::int[], $6::int[]) AS x(u, o, r, rc, dc)
     ON CONFLICT (cycle_id, url) DO UPDATE SET
       our_count = EXCLUDED.our_count, read_count = EXCLUDED.read_count,
       rank_cluster = EXCLUDED.rank_cluster, date_cluster = EXCLUDED.date_cluster`,
    [
      cycleId,
      rows.map((r) => r.url),
      rows.map((r) => r.ourCount),
      rows.map((r) => r.readCount),
      rows.map((r) => r.rankCluster),
      rows.map((r) => r.dateCluster),
    ]
  )
}

export interface CoverageRow {
  /** '' for the overall figure, else 'rank 4' / 'date 2'. */
  cluster: string
  /** Links read in the LATER cycle that were also read in the earlier one. */
  compared: number
  /** Of those, how many had none of ours in the earlier cycle. */
  lacked: number
  /** Of those lacking, how many have at least one of ours now. */
  gained: number
  /** Links read in the later cycle, whatever the earlier one saw. */
  read: number
  /** Of those, carrying at least one of ours now. */
  withOurs: number
}

/**
 * Compare two cycles link by link.
 *
 * Only links BOTH cycles read can be compared: a link the later cycle did not
 * reach says nothing about whether it gained a comment, and counting it as "not
 * gained" would report the scan's own coverage as a failure to place comments.
 *
 * The two dimensions are reported differently on purpose. There are thirty
 * search-rank clusters and they are ONE population as far as this question goes,
 * so they come back as a single row. The posted-date side covers only the top
 * three and those are worth seeing apart, so they come back one row each.
 *
 * A link can sit in a rank cluster and a date cluster at once, so the two
 * results overlap rather than summing.
 */
export async function getCycleCoverage(
  earlierId: number,
  laterId: number,
  by: 'rank' | 'date'
): Promise<CoverageRow[]> {
  await ensureClickedTable()
  const col = by === 'rank' ? 'rank_cluster' : 'date_cluster'
  const perCluster = by === 'date'
  const { rows } = await pool.query<{
    cluster: number | null
    compared: number
    lacked: number
    gained: number
    read: number
    with_ours: number
  }>(
    `SELECT ${perCluster ? `cur.${col}` : 'NULL::int'} AS cluster,
            COUNT(*) FILTER (WHERE prev.url IS NOT NULL)::int                        AS compared,
            COUNT(*) FILTER (WHERE prev.our_count = 0)::int                          AS lacked,
            COUNT(*) FILTER (WHERE prev.our_count = 0 AND cur.our_count > 0)::int    AS gained,
            COUNT(*)::int                                                            AS read,
            COUNT(*) FILTER (WHERE cur.our_count > 0)::int                           AS with_ours
       FROM pipeline_scan cur
       LEFT JOIN pipeline_scan prev ON prev.url = cur.url AND prev.cycle_id = $1
      WHERE cur.cycle_id = $2 AND cur.${col} IS NOT NULL
      ${perCluster ? `GROUP BY cur.${col} ORDER BY cur.${col}` : ''}`,
    [earlierId, laterId]
  )
  return rows
    // The ungrouped form still returns a row when nothing matched; drop it, or
    // the report shows a table of zeroes rather than saying there is nothing.
    .filter((r) => r.read > 0)
    .map((r) => ({
      cluster: perCluster ? `date cluster ${r.cluster}` : 'all search-rank clusters',
      compared: r.compared,
      lacked: r.lacked,
      gained: r.gained,
      read: r.read,
      withOurs: r.with_ours,
    }))
}

/** Keep the table from growing without bound: drop scans for old cycles. */
export async function prunePipelineScans(keepCycles = 8): Promise<number> {
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    `DELETE FROM pipeline_scan
      WHERE cycle_id NOT IN (
        SELECT id FROM pipeline_cycle ORDER BY started_at DESC LIMIT $1
      )`,
    [Math.max(2, keepCycles)]
  )
  return rowCount ?? 0
}

/** Cycles newest first, for the report. */
export async function getPipelineCycles(limit = 60): Promise<PipelineCycle[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{
    id: string
    started_at: Date
    finished_at: Date | null
    stages: Record<string, Record<string, unknown>> | null
  }>(
    `SELECT id, started_at, finished_at, stages
       FROM pipeline_cycle ORDER BY started_at DESC LIMIT $1`,
    [Math.max(1, Math.min(500, limit))]
  )
  return rows.map((r) => ({
    id: Number(r.id),
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    stages: r.stages ?? {},
  }))
}

/** One named value, or null when it has never been set. */
export async function getAppState(key: string): Promise<string | null> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ value: string }>(
    'SELECT value FROM app_kv WHERE key = $1',
    [key]
  )
  return rows[0]?.value ?? null
}

// ── Which LLM every generation uses ──────────────────────────────────────────
// One setting for the whole app: comments, replies, title classification and
// audience analysis all run through groqChat, so choosing here changes all of
// them. Stored rather than compiled in so it can be switched without a deploy —
// which is the point when one model starts refusing or drifting.

/** The chosen model, or the default when nothing has been chosen. */
export async function getLlmModel(): Promise<LlmModel> {
  const v = await getAppState('llm_model').catch(() => null)
  return isLlmModel(v) ? v : DEFAULT_LLM_MODEL
}

/** Choose the model. Anything not on the list is refused rather than stored. */
export async function setLlmModel(model: string): Promise<LlmModel> {
  if (!isLlmModel(model)) throw new Error(`Unknown model: ${model}`)
  await setAppState('llm_model', model)
  return model
}

/** Set one named value. */
export async function setAppState(key: string, value: string): Promise<void> {
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO app_kv (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  )
}

// ── How the two clusterings are mixed ────────────────────────────────────────
// A percentage, set on the admin Links page: how often a served link is drawn
// from the posted-date ordering rather than the search-rank one. Replaces the
// old five-minute rank/date schedule, which made the ratio depend on the clock.

const CLUSTER_DATE_SHARE_KEY = 'cluster_date_share'

export async function getClusterDateShare(): Promise<number> {
  const raw = await getAppState(CLUSTER_DATE_SHARE_KEY).catch(() => null)
  return clampShare(raw)
}

export async function setClusterDateShare(pct: number): Promise<number> {
  const v = clampShare(pct)
  await setAppState(CLUSTER_DATE_SHARE_KEY, String(v))
  return v
}

// ── Serve only links that carry none of our comments ────────────────────────
// Off by default. On, the app and the web dashboard withhold every link already
// known to carry one of our product comments, so a session is spent on videos
// nobody has commented on yet.
//
// "Known to carry one" is the only thing that can be excluded. A link nobody has
// extracted might have ten of ours on it or none — that is what UNEXTRACTED
// means — and withholding those too would cut the pool from ~148k to the 13k
// that have actually been read, which is not what "no product comments" is
// asking for.

const SERVE_ONLY_CLEAN_KEY = "serve_only_clean"

export async function getServeOnlyClean(): Promise<boolean> {
  const raw = await getAppState(SERVE_ONLY_CLEAN_KEY).catch(() => null)
  return raw === "1"
}

export async function setServeOnlyClean(on: boolean): Promise<boolean> {
  await setAppState(SERVE_ONLY_CLEAN_KEY, on ? "1" : "0")
  return on
}

/**
 * Every URL an extraction has found one of our comments on.
 *
 * Just the URLs — the serving paths only need to know WHETHER, and the full
 * per-product counts are a much larger read for a set membership test.
 */
export async function getUrlsWithProductComments(): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    "SELECT DISTINCT url FROM link_product_comment WHERE product IS NOT NULL"
  )
  return rows.map((r) => r.url)
}

/** The database's own clock, as an ISO string.
 *
 * Freshness is compared against checked_at, which is written by now() on the
 * server. Taking the cutoff from the browser or a serverless instance instead
 * would drift, and a cutoff a few seconds in the future silently marks a whole
 * pass as stale. */
export async function dbNow(): Promise<string> {
  const { rows } = await pool.query<{ now: Date }>('SELECT now() AS now')
  return rows[0].now.toISOString()
}

/**
 * URLs already judged for this user/day, so a resumed pass skips them.
 *
 * `freshSince` is what stops a pass from reusing a verdict it did not make. A
 * link judged before that instant counts as UNJUDGED and gets read again, so
 * "check comment presence" means checking the links now rather than reprinting
 * what an earlier run concluded. Omit it to accept the ledger at any age, which
 * is what the per-link resume inside a single pass relies on.
 */
export async function getJudgedLinks(
  userId: string,
  day: string,
  freshSince?: string | null
): Promise<Set<string>> {
  await ensureClickedTable()
  const { rows } = freshSince
    ? await pool.query<{ url: string }>(
        `SELECT url FROM comment_presence_link
          WHERE user_id = $1 AND day = $2::date AND checked_at >= $3::timestamptz`,
        [userId, day, freshSince]
      )
    : await pool.query<{ url: string }>(
        'SELECT url FROM comment_presence_link WHERE user_id = $1 AND day = $2::date',
        [userId, day]
      )
  return new Set(rows.map((r) => r.url))
}

/** Record judged links, then refresh the day's totals from the ledger. */
export interface PresenceLinkRow {
  url: string
  day: string
  found: boolean
  judgeable: boolean
  /** What the user wrote, when the judging pass captured it. */
  text: string | null
  /** Comments on the video, as TikTok reported them at judging time. */
  comments: number | null
  hearts: number | null
  views: number | null
  isPhoto: boolean | null
  checkedAt: string
  /** When the user opened this link. Null if the click row is gone (a reset). */
  clickedAt: string | null
  /** The comment the server told them to post. Null for clicks recorded before
   *  it was stored, which is every click up to this change. */
  assigned: string | null
  /** The video's title, when the title fetch has cached one. */
  title: string | null
  /** Which product's comment pool this click drew from. Recorded since long
   *  before the text was, so it is the one clue old clicks still carry. */
  product: string | null
}

/**
 * Every link judged for one user, newest day first, with the video's own
 * numbers alongside.
 *
 * The counts come from link_stat (the hearts refresh) and are simply null for
 * links it has not reached — a missing number is shown as unknown rather than
 * as zero, because zero views is a claim and we do not have the evidence.
 */
export async function getPresenceLinks(
  userId: string,
  days = 7,
  limit = 400
): Promise<PresenceLinkRow[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{
    url: string
    day: Date
    found: boolean
    judgeable: boolean
    comment_text: string | null
    comment_total: number | null
    heart_count: string | null
    view_count: string | null
    is_photo: boolean | null
    checked_at: Date
    clicked_at: Date | null
    served_comment: string | null
    product: string | null
    title: string | null
  }>(
    `SELECT l.url, l.day, l.found, l.judgeable, l.comment_text, l.comment_total,
            s.heart_count, s.view_count, s.is_photo, l.checked_at,
            c.clicked_at, c.served_comment, c.product, t.title
       FROM comment_presence_link l
       LEFT JOIN link_stat s ON s.url = l.url
       LEFT JOIN link_title t ON t.url = l.url
       -- LATERAL with ORDER BY/LIMIT rather than min(): a user can have more
       -- than one click row for the same link, and this takes the whole
       -- earliest row so the comment matches the time it reports.
       LEFT JOIN LATERAL (
         SELECT ck.clicked_at, ck.served_comment, ck.product
           FROM clicked_link ck
          WHERE ck.user_id = l.user_id AND ck.url = l.url
            AND ck.clicked_at::date = l.day
          ORDER BY ck.clicked_at
          LIMIT 1
       ) c ON true
      WHERE l.user_id = $1 AND l.day >= (now() - ($2::int || ' days')::interval)::date
      ORDER BY l.day DESC, l.found DESC, l.url
      LIMIT $3`,
    [userId, days, Math.max(1, Math.min(1000, limit))]
  )
  return rows.map((r) => ({
    url: r.url,
    day: r.day.toISOString().slice(0, 10),
    found: r.found,
    judgeable: r.judgeable,
    text: r.comment_text,
    comments: r.comment_total,
    hearts: r.heart_count === null ? null : Number(r.heart_count),
    views: r.view_count === null ? null : Number(r.view_count),
    isPhoto: r.is_photo,
    checkedAt: r.checked_at.toISOString(),
    clickedAt: r.clicked_at ? r.clicked_at.toISOString() : null,
    assigned: r.served_comment,
    title: r.title,
    product: r.product,
  }))
}

/** Fill in a comment captured after the fact (older rows predate the column). */
export async function setPresenceCommentText(
  userId: string,
  day: string,
  url: string,
  text: string | null,
  total: number | null
): Promise<void> {
  await pool.query(
    `UPDATE comment_presence_link
        SET comment_text = COALESCE($4, comment_text),
            comment_total = COALESCE($5, comment_total)
      WHERE user_id = $1 AND day = $2::date AND url = $3`,
    [userId, day, url, text, total]
  )
}
// ── The TikTok account behind a handle ───────────────────────────────────────

/**
 * Remember the numeric TikTok id a presence check saw on this user's comment.
 *
 * Stored against the handle it came from: if the user later changes their
 * profile link, the row no longer matches and is ignored, so the dashboard says
 * "unknown" rather than dating the account they used to have.
 */
export async function recordTiktokAccount(
  userId: string,
  handle: string,
  uid: string
): Promise<void> {
  if (!userId || !handle || !/^\d+$/.test(uid)) return
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO tiktok_account (user_id, handle, uid)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       handle = EXCLUDED.handle, uid = EXCLUDED.uid, seen_at = now()`,
    [userId, handle.toLowerCase(), uid]
  )
}

export interface TiktokAccountRow {
  handle: string
  uid: string
}

/** Every known TikTok id, by user id. */
export async function getTiktokAccounts(): Promise<Record<string, TiktokAccountRow>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ user_id: string; handle: string; uid: string }>(
    'SELECT user_id, handle, uid FROM tiktok_account'
  )
  const out: Record<string, TiktokAccountRow> = {}
  for (const r of rows) out[r.user_id] = { handle: r.handle, uid: r.uid }
  return out
}

/**
 * A link where this user's comment was found, newest first.
 *
 * Used to learn the id for a user scored before it was being captured: one
 * re-read of a link already known to carry their comment is enough.
 */
export async function getFoundPresenceLinks(userId: string, limit = 5): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    // DISTINCT ON, because one link judged on several days is several rows —
    // and a caller with four tries would spend them all re-reading it.
    `SELECT url FROM (
       SELECT DISTINCT ON (url) url, day, checked_at
         FROM comment_presence_link
        WHERE user_id = $1 AND found
        ORDER BY url, day DESC, checked_at DESC
     ) t
      ORDER BY t.day DESC, t.checked_at DESC
      LIMIT $2`,
    [userId, Math.max(1, Math.min(20, limit))]
  )
  return rows.map((r) => r.url)
}

export async function saveJudgedLinks(
  userId: string,
  day: string,
  links: { url: string; found: boolean; judgeable: boolean; text?: string | null; total?: number | null }[],
  /** When the current pass began. Given, the day's totals count only verdicts
   *  from this pass — see the comment on the recompute below. */
  freshSince?: string | null
): Promise<void> {
  if (links.length === 0) return
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO comment_presence_link (user_id, day, url, found, judgeable, comment_text, comment_total)
     SELECT $1, $2::date, u, f, j, t, n
       FROM unnest($3::text[], $4::bool[], $5::bool[], $6::text[], $7::int[]) AS x(u, f, j, t, n)
     ON CONFLICT (user_id, day, url) DO UPDATE SET
       found = EXCLUDED.found, judgeable = EXCLUDED.judgeable,
       -- COALESCE, so re-judging a link that came back unreadable this time
       -- does not erase the comment a previous pass captured.
       comment_text  = COALESCE(EXCLUDED.comment_text,  comment_presence_link.comment_text),
       comment_total = COALESCE(EXCLUDED.comment_total, comment_presence_link.comment_total),
       checked_at = now()`,
    [
      userId,
      day,
      links.map((l) => l.url),
      links.map((l) => l.found),
      links.map((l) => l.judgeable),
      links.map((l) => l.text ?? null),
      links.map((l) => l.total ?? null),
    ]
  )
  // The day row is a derived total, always recomputed from the ledger — so it
  // stays correct however many times a pass is interrupted and resumed.
  //
  // `freshSince` narrows that to the verdicts THIS pass made. It matters more
  // than it looks: the ledger accumulates a row for every link any pass ever
  // judged, and a day keeps growing while it is being swept, so an early pass
  // and a later one judge overlapping but different sets. One real user has 431
  // rows for a single day. Totalling all of them would mix a hundred readings
  // taken just now with three hundred taken hours ago and report the average as
  // today's score — precisely what a fresh check is supposed to stop.
  //
  // (This used to say the day was capped at 100 links. It no longer is: every
  // link opened that day is read — see lib/commentPresence.)
  await pool.query(
    freshSince
      ? `INSERT INTO comment_presence (user_id, day, checked, found, skipped)
         SELECT $1, $2::date,
                count(*) FILTER (WHERE judgeable)::int,
                count(*) FILTER (WHERE found)::int,
                count(*) FILTER (WHERE NOT judgeable)::int
           FROM comment_presence_link
          WHERE user_id = $1 AND day = $2::date AND checked_at >= $3::timestamptz
         ON CONFLICT (user_id, day) DO UPDATE SET
           checked = EXCLUDED.checked, found = EXCLUDED.found,
           skipped = EXCLUDED.skipped, updated_at = now()`
      : `INSERT INTO comment_presence (user_id, day, checked, found, skipped)
         SELECT $1, $2::date,
                count(*) FILTER (WHERE judgeable)::int,
                count(*) FILTER (WHERE found)::int,
                count(*) FILTER (WHERE NOT judgeable)::int
           FROM comment_presence_link WHERE user_id = $1 AND day = $2::date
         ON CONFLICT (user_id, day) DO UPDATE SET
           checked = EXCLUDED.checked, found = EXCLUDED.found,
           skipped = EXCLUDED.skipped, updated_at = now()`,
    freshSince ? [userId, day, freshSince] : [userId, day]
  )
}

/** One user's last day with a TikTok click, or null if they never clicked. */
export async function getLastActiveDay(userId: string): Promise<string | null> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ d: Date | null }>(
    `SELECT max(clicked_at)::date AS d FROM clicked_link
      WHERE user_id = $1 AND url ILIKE '%tiktok.com%'`,
    [userId]
  )
  const d = rows[0]?.d
  return d ? d.toISOString().slice(0, 10) : null
}

/** Every judged link for one user/day, for the per-link report. */
export async function getJudgedLinkRows(
  userId: string,
  day: string
): Promise<{ url: string; found: boolean; judgeable: boolean }[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; found: boolean; judgeable: boolean }>(
    `SELECT url, found, judgeable FROM comment_presence_link
      WHERE user_id = $1 AND day = $2::date
      ORDER BY found DESC, url`,
    [userId, day]
  )
  return rows
}

/**
 * A user's most recent TikTok links with the day each was opened, newest first.
 *
 * Spans days on purpose. The auto-block rule needs a sample of a fixed size, and
 * a light day would otherwise be judged on a handful of links — so a short day
 * is topped up from the days before it.
 */
export async function getRecentClickedLinks(
  userId: string,
  limit: number
): Promise<{ url: string; day: string }[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; day: Date }>(
    `SELECT url, clicked_at::date AS day
       FROM clicked_link
      WHERE user_id = $1 AND url ILIKE '%tiktok.com%'
      ORDER BY clicked_at DESC, url
      LIMIT $2`,
    [userId, Math.max(1, Math.min(500, limit))]
  )
  return rows.map((r) => ({ url: r.url, day: r.day.toISOString().slice(0, 10) }))
}

/** Verdicts already in the ledger for these exact (day, url) pairs. */
export async function getJudgedVerdicts(
  userId: string,
  pairs: { url: string; day: string }[]
): Promise<Map<string, { found: boolean; judgeable: boolean }>> {
  const out = new Map<string, { found: boolean; judgeable: boolean }>()
  if (pairs.length === 0) return out
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; day: Date; found: boolean; judgeable: boolean }>(
    `SELECT url, day, found, judgeable
       FROM comment_presence_link
      WHERE user_id = $1
        AND (url, day) IN (
          SELECT u, d::date FROM unnest($2::text[], $3::text[]) AS x(u, d)
        )`,
    [userId, pairs.map((p) => p.url), pairs.map((p) => p.day)]
  )
  for (const r of rows) {
    out.set(`${r.day.toISOString().slice(0, 10)}|${r.url}`, {
      found: r.found,
      judgeable: r.judgeable,
    })
  }
  return out
}

export async function saveCommentPresence(
  userId: string,
  day: string,
  v: { checked: number; found: number; skipped: number }
): Promise<void> {
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO comment_presence (user_id, day, checked, found, skipped)
     VALUES ($1, $2::date, $3, $4, $5)
     ON CONFLICT (user_id, day) DO UPDATE SET
       checked = EXCLUDED.checked, found = EXCLUDED.found,
       skipped = EXCLUDED.skipped, updated_at = now()`,
    [userId, day, v.checked, v.found, v.skipped]
  )
}

/** The last `days` days of scores for every user, newest day first. */
/** One user's day rows, oldest first — the shape a trend line wants. */
export async function getPresenceHistoryForUser(
  userId: string,
  days: number
): Promise<PresenceDay[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{
    day: Date; checked: number; found: number; skipped: number
  }>(
    `SELECT day, checked, found, skipped FROM comment_presence
      WHERE user_id = $1 AND day >= (now() - ($2::int || ' days')::interval)::date
      ORDER BY day`,
    [userId, days]
  )
  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    checked: r.checked,
    found: r.found,
    skipped: r.skipped,
    // Null, not 0: a day nothing could be judged on is a gap in the line, and
    // drawing it at zero would invent a collapse that never happened.
    pct: r.checked > 0 ? Math.round((100 * r.found) / r.checked) : null,
  }))
}

export async function getPresenceHistory(days: number): Promise<Record<string, PresenceDay[]>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{
    user_id: string; day: Date; checked: number; found: number; skipped: number
  }>(
    `SELECT user_id, day, checked, found, skipped FROM comment_presence
      WHERE day >= (now() - ($1::int || ' days')::interval)::date
      ORDER BY day DESC`,
    [days]
  )
  const out: Record<string, PresenceDay[]> = {}
  for (const r of rows) {
    ;(out[r.user_id] = out[r.user_id] ?? []).push({
      day: r.day.toISOString().slice(0, 10),
      checked: r.checked,
      found: r.found,
      skipped: r.skipped,
      // A day where nothing could be judged has no percentage — it must not
      // read as 0%, which would drag the average down for a scraping failure.
      pct: r.checked > 0 ? Math.round((100 * r.found) / r.checked) : null,
    })
  }
  return out
}

/**
 * The badge number: the MEAN OF THE DAILY percentages, not found/checked overall.
 *
 * Averaging the days weights every working day equally, so one heavy day cannot
 * drown out a week of light ones. Days with nothing judgeable are left out.
 */
export async function getPresenceAverages(): Promise<Record<string, { pct: number; days: number }>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ user_id: string; pct: string; days: string }>(
    `SELECT user_id,
            avg(100.0 * found / NULLIF(checked, 0))::text AS pct,
            count(*) FILTER (WHERE checked > 0)::text AS days
       FROM comment_presence
      GROUP BY user_id`
  )
  const out: Record<string, { pct: number; days: number }> = {}
  for (const r of rows) {
    const days = Number(r.days)
    if (days > 0 && r.pct !== null) out[r.user_id] = { pct: Math.round(Number(r.pct)), days }
  }
  return out
}

// ── Link audience categories ─────────────────────────────────────────────────

/**
 * The category of ONE link, or null when it has never been categorised.
 *
 * Serving a comment needs this one row, not the 150k-row map getLinkCategories
 * returns — that is a page-load's worth of data to answer a question about a
 * single URL, on the hottest path there is (every click).
 */
export async function getLinkCategory(url: string): Promise<string | null> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ category: string }>(
    'SELECT category FROM link_category WHERE url = $1',
    [url]
  )
  return rows[0]?.category ?? null
}

/** The categories of a specific set of links, as { url: category }. */
export async function getLinkCategoriesFor(urls: string[]): Promise<Record<string, string>> {
  if (urls.length === 0) return {}
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; category: string }>(
    'SELECT url, category FROM link_category WHERE url = ANY($1::text[])',
    [urls]
  )
  const out: Record<string, string> = {}
  for (const r of rows) out[r.url] = r.category
  return out
}

/** Every categorised URL -> its category. */
export async function getLinkCategories(): Promise<Record<string, string>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; category: string }>(
    'SELECT url, category FROM link_category'
  )
  const out: Record<string, string> = {}
  for (const r of rows) out[r.url] = r.category
  return out
}

export async function countLinkCategories(): Promise<Record<string, number>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ category: string; n: string }>(
    'SELECT category, count(*)::text AS n FROM link_category GROUP BY category'
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.category] = Number(r.n)
  return out
}

export async function saveLinkCategories(
  rows: { url: string; category: string }[]
): Promise<number> {
  const clean = rows.filter((r) => r.url && r.category)
  if (clean.length === 0) return 0
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    `INSERT INTO link_category (url, category)
     SELECT u, c FROM unnest($1::text[], $2::text[]) AS x(u, c)
     ON CONFLICT (url) DO UPDATE SET category = EXCLUDED.category, decided_at = now()`,
    [clean.map((r) => r.url), clean.map((r) => r.category)]
  )
  return rowCount ?? 0
}

/** Wipe every decision, so the next pass re-reads the whole pool. */
export async function clearLinkCategories(): Promise<number> {
  await ensureClickedTable()
  const { rowCount } = await pool.query('DELETE FROM link_category')
  return rowCount ?? 0
}

// ── Channel bios ─────────────────────────────────────────────────────────────

export async function getChannelBios(): Promise<Record<string, string>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ handle: string; bio: string }>(
    'SELECT handle, bio FROM channel_bio'
  )
  const out: Record<string, string> = {}
  for (const r of rows) out[r.handle] = r.bio
  return out
}

export async function saveChannelBios(rows: { handle: string; bio: string }[]): Promise<number> {
  const clean = rows.filter((r) => r.handle && r.bio)
  if (clean.length === 0) return 0
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    `INSERT INTO channel_bio (handle, bio)
     SELECT h, b FROM unnest($1::text[], $2::text[]) AS x(h, b)
     ON CONFLICT (handle) DO UPDATE SET bio = EXCLUDED.bio, updated_at = now()`,
    [clean.map((r) => r.handle.toLowerCase()), clean.map((r) => r.bio.slice(0, 500))]
  )
  return rowCount ?? 0
}

/**
 * Harvest channel bios out of the verify staging list into channel_bio.
 *
 * verify_link holds the bio per LINK; this collapses it to one row per channel so
 * the bio survives the merge that drops it. Runs before a categorise pass.
 */
export async function harvestChannelBios(): Promise<number> {
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    `INSERT INTO channel_bio (handle, bio)
     SELECT lower(account), (array_agg(bio ORDER BY length(bio) DESC))[1]
     FROM verify_link
     WHERE COALESCE(account, '') <> '' AND COALESCE(bio, '') <> ''
     GROUP BY lower(account)
     ON CONFLICT (handle) DO UPDATE SET bio = EXCLUDED.bio, updated_at = now()`
  )
  return rowCount ?? 0
}

// ── Browsing the block list ──────────────────────────────────────────────────
// The Links page can only show blocked links that are still in videos.json, and
// almost none are — 97k of 99k blocked URLs have no pool row left. So the block
// list is browsed straight from this table, with titles joined in from
// link_title so a row can be judged without opening it.

export interface BlockedLinkRow {
  url: string
  blockedAt: string
  title: string
}

export type BlockedSort = 'recent' | 'oldest' | 'url'

/** One window of the block list, plus how many rows match the search. */
export async function getBlockedLinksPage(opts: {
  offset: number
  limit: number
  q?: string
  sort?: BlockedSort
}): Promise<{ rows: BlockedLinkRow[]; matched: number }> {
  await ensureClickedTable()
  const q = (opts.q ?? '').trim()
  // ILIKE on url OR title; the pattern is parameterised, so a % or _ typed into
  // the search box is a literal wildcard rather than an injection risk.
  const where = q ? `WHERE b.url ILIKE $1 OR COALESCE(t.title, '') ILIKE $1` : ''
  const params: unknown[] = q ? [`%${q}%`] : []
  const order =
    opts.sort === 'oldest' ? 'b.blocked_at ASC' : opts.sort === 'url' ? 'b.url ASC' : 'b.blocked_at DESC'

  const countSql = `SELECT count(*)::text AS n FROM blocked_link b
                    LEFT JOIN link_title t ON t.url = b.url ${where}`
  const { rows: cnt } = await pool.query<{ n: string }>(countSql, params)

  const sql = `SELECT b.url, b.blocked_at, COALESCE(t.title, '') AS title
               FROM blocked_link b
               LEFT JOIN link_title t ON t.url = b.url
               ${where}
               ORDER BY ${order}
               LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
  const { rows } = await pool.query<{ url: string; blocked_at: Date; title: string }>(
    sql,
    [...params, Math.max(1, Math.min(500, opts.limit)), Math.max(0, opts.offset)]
  )
  return {
    matched: Number(cnt[0]?.n ?? 0),
    rows: rows.map((r) => ({
      url: r.url,
      blockedAt: r.blocked_at.toISOString(),
      title: r.title ?? '',
    })),
  }
}

/** One channel's share of the block list. */
export interface BlockedChannelRow {
  handle: string
  blocked: number
  lastBlocked: string
  sampleUrl: string
}

/**
 * The block list collapsed to one row per channel.
 *
 * 100k blocked links is unreadable link by link, but "which channels have I been
 * rejecting, and how heavily" is a question the list can actually answer — and
 * it is the view you want before unblocking, since a block is almost always a
 * judgement about a channel rather than one video.
 *
 * Links with no channel in the URL (YouTube video ids) are excluded: they cannot
 * be grouped, and showing them as one giant "unknown" row would be noise.
 */
export async function getBlockedChannels(opts: {
  offset: number
  limit: number
  q?: string
  sort?: BlockedSort
}): Promise<{ rows: BlockedChannelRow[]; matched: number; links: number }> {
  await ensureClickedTable()
  const q = (opts.q ?? '').trim()
  // The handle, pulled straight out of the URL. Kept in one expression so the
  // count, the ordering and the rows can never disagree about what a channel is.
  const HANDLE = `substring(b.url from 'tiktok\\.com/@([A-Za-z0-9._]+)/')`
  const where = q
    ? `WHERE ${HANDLE} IS NOT NULL AND (b.url ILIKE $1 OR ${HANDLE} ILIKE $1)`
    : `WHERE ${HANDLE} IS NOT NULL`
  const params: unknown[] = q ? [`%${q}%`] : []

  const { rows: cnt } = await pool.query<{ n: string; links: string }>(
    `SELECT count(*)::text AS n, COALESCE(sum(c), 0)::text AS links
       FROM (SELECT count(*) AS c FROM blocked_link b ${where} GROUP BY ${HANDLE}) g`,
    params
  )

  // 'url' sorts alphabetically by handle; the date sorts use the channel's most
  // recent block, which is what "newest blocked" means for a group.
  const order =
    opts.sort === 'oldest'
      ? 'max(b.blocked_at) ASC'
      : opts.sort === 'url'
        ? `${HANDLE} ASC`
        : 'max(b.blocked_at) DESC'

  const { rows } = await pool.query<{
    handle: string
    n: string
    last_blocked: Date
    sample_url: string
  }>(
    `SELECT ${HANDLE} AS handle,
            count(*)::text AS n,
            max(b.blocked_at) AS last_blocked,
            (array_agg(b.url ORDER BY b.blocked_at DESC))[1] AS sample_url
       FROM blocked_link b
       ${where}
      GROUP BY ${HANDLE}
      ORDER BY ${order}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, Math.max(1, Math.min(500, opts.limit)), Math.max(0, opts.offset)]
  )

  return {
    matched: Number(cnt[0]?.n ?? 0),
    links: Number(cnt[0]?.links ?? 0),
    rows: rows.map((r) => ({
      handle: r.handle,
      blocked: Number(r.n),
      lastBlocked: r.last_blocked.toISOString(),
      sampleUrl: r.sample_url,
    })),
  }
}

/** Every blocked URL belonging to these channels — backs a whole-channel unblock. */
export async function getBlockedUrlsForChannels(handles: string[]): Promise<string[]> {
  const clean = handles.map((h) => h.replace(/^@/, '').trim()).filter(Boolean)
  if (clean.length === 0) return []
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    `SELECT url FROM blocked_link
      WHERE lower(substring(url from 'tiktok\\.com/@([A-Za-z0-9._]+)/')) = ANY($1::text[])`,
    [clean.map((h) => h.toLowerCase())]
  )
  return rows.map((r) => r.url)
}

/** Every URL matching the search — backs "select all matching". */
export async function getBlockedLinkUrls(q?: string): Promise<string[]> {
  await ensureClickedTable()
  const term = (q ?? '').trim()
  const sql = term
    ? `SELECT b.url FROM blocked_link b LEFT JOIN link_title t ON t.url = b.url
       WHERE b.url ILIKE $1 OR COALESCE(t.title, '') ILIKE $1`
    : 'SELECT url FROM blocked_link b'
  const { rows } = await pool.query<{ url: string }>(sql, term ? [`%${term}%`] : [])
  return rows.map((r) => r.url)
}

/** Lift the block on many URLs at once. Returns how many were actually blocked. */
export async function unblockLinks(urls: string[]): Promise<number> {
  const clean = urls.map((u) => String(u).trim()).filter(Boolean)
  if (clean.length === 0) return 0
  await ensureClickedTable()
  const { rowCount } = await pool.query('DELETE FROM blocked_link WHERE url = ANY($1::text[])', [clean])
  return rowCount ?? 0
}

// Every permanently-blocked URL (for filtering the served link lists).
export async function getBlockedUrls(): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>('SELECT url FROM blocked_link')
  return rows.map((r) => r.url)
}

// ── Broken links ─────────────────────────────────────────────────────────────
// Links the platform no longer serves. Kept out of every user's list the same
// way blocked links are, but reversible on its own: a post that comes back is
// restored by the next check rather than needing an admin to notice.

export interface BrokenLinkRow {
  url: string
  reason: string
  misses: number
  firstSeen: string
  lastChecked: string
}

/** Every broken URL, for filtering. */
export async function getBrokenUrls(): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>('SELECT url FROM broken_link')
  return rows.map((r) => r.url)
}

/** A page of broken links, newest first, for the modal. */
export async function getBrokenLinks(
  limit = 200,
  offset = 0
): Promise<{ rows: BrokenLinkRow[]; total: number }> {
  await ensureClickedTable()
  const [page, count] = await Promise.all([
    pool.query<{
      url: string
      reason: string
      misses: number
      first_seen: string
      last_checked: string
    }>(
      `SELECT url, reason, misses, first_seen, last_checked
         FROM broken_link ORDER BY first_seen DESC, url LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM broken_link'),
  ])
  return {
    rows: page.rows.map((r) => ({
      url: r.url,
      reason: r.reason,
      misses: r.misses,
      firstSeen: String(r.first_seen),
      lastChecked: String(r.last_checked),
    })),
    total: count.rows[0]?.n ?? 0,
  }
}

/**
 * Record a dead reading.
 *
 * A link only BECOMES broken once it has read dead `threshold` times running —
 * the same empty response comes back from a rate limit, so one reading is a
 * suspicion, not a verdict. Returns how many links crossed the threshold on
 * this call.
 */
export async function recordBrokenReadings(
  urls: string[],
  reason: string,
  threshold: number
): Promise<number> {
  if (urls.length === 0) return 0
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; misses: number }>(
    `INSERT INTO broken_link (url, reason, misses)
     SELECT u, $2, 1 FROM unnest($1::text[]) AS u
     ON CONFLICT (url) DO UPDATE
       SET misses = broken_link.misses + 1, reason = $2, last_checked = now()
     RETURNING url, misses`,
    [urls, reason.slice(0, 120)]
  )
  return rows.filter((r) => r.misses >= threshold).length
}

/**
 * Clear a link's dead readings — it answered.
 *
 * Called for every link that reads ALIVE, not only for ones already listed:
 * that is what makes a run of near-misses reset instead of accumulating across
 * unrelated passes until an intermittent link is condemned.
 */
export async function clearBrokenReadings(urls: string[]): Promise<number> {
  if (urls.length === 0) return 0
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    'DELETE FROM broken_link WHERE url = ANY($1::text[])',
    [urls]
  )
  return rowCount ?? 0
}

/** URLs whose dead readings have reached the threshold — the ones withheld. */
export async function getConfirmedBrokenUrls(threshold: number): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    'SELECT url FROM broken_link WHERE misses >= $1',
    [threshold]
  )
  return rows.map((r) => r.url)
}

// ── Cached video titles ──────────────────────────────────────────────────────
// All saved titles, keyed by URL (seeds the admin Links page so titles never
// need re-fetching once extracted).
// ── Refreshed engagement counts ──────────────────────────────────────────────

export interface LinkStat {
  hearts: number | null
  views: number | null
  isPhoto: boolean | null
  fetchedAt: string
}

/** Upsert refreshed counts. Null fields leave the stored value alone. */
export async function saveLinkStats(
  stats: { url: string; hearts: number | null; views: number | null; isPhoto?: boolean | null }[]
): Promise<number> {
  const clean = stats.filter(
    (s) => s.url && (s.hearts !== null || s.views !== null || (s.isPhoto ?? null) !== null)
  )
  if (clean.length === 0) return 0
  await ensureClickedTable()
  const { rowCount } = await pool.query(
    `INSERT INTO link_stat (url, heart_count, view_count, is_photo)
     SELECT u, h, v, p FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::boolean[]) AS x(u, h, v, p)
     ON CONFLICT (url) DO UPDATE SET
       heart_count = COALESCE(EXCLUDED.heart_count, link_stat.heart_count),
       view_count  = COALESCE(EXCLUDED.view_count,  link_stat.view_count),
       is_photo    = COALESCE(EXCLUDED.is_photo,    link_stat.is_photo),
       fetched_at  = now()`,
    [
      clean.map((s) => s.url),
      clean.map((s) => s.hearts),
      clean.map((s) => s.views),
      clean.map((s) => s.isPhoto ?? null),
    ]
  )
  return rowCount ?? 0
}

export async function getLinkStats(): Promise<Record<string, LinkStat>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{
    url: string
    heart_count: string | null
    view_count: string | null
    is_photo: boolean | null
    fetched_at: Date
  }>('SELECT url, heart_count, view_count, is_photo, fetched_at FROM link_stat')
  const out: Record<string, LinkStat> = {}
  for (const r of rows) {
    out[r.url] = {
      // bigint comes back as a string from pg; Number is safe at these magnitudes.
      hearts: r.heart_count === null ? null : Number(r.heart_count),
      views: r.view_count === null ? null : Number(r.view_count),
      isPhoto: r.is_photo,
      fetchedAt: r.fetched_at.toISOString(),
    }
  }
  return out
}

/** How many links already have refreshed counts — drives the progress bar. */
export async function countLinkStats(): Promise<number> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM link_stat')
  return Number(rows[0]?.n ?? 0)
}

export async function getLinkTitles(): Promise<Record<string, string>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; title: string }>('SELECT url, title FROM link_title')
  const out: Record<string, string> = {}
  // Skip previously-cached login-wall placeholders ("Login • Instagram", …) so
  // they never display and the link becomes eligible for re-fetching.
  for (const r of rows) if (r.title && !isGenericTitle(r.title)) out[r.url] = r.title
  return out
}

// Bulk-save fetched titles (upsert). Returns how many rows were written.
export async function saveLinkTitles(titles: Record<string, string>): Promise<number> {
  const entries = Object.entries(titles).filter(([u, t]) => u && t && !isGenericTitle(t))
  if (entries.length === 0) return 0
  await ensureClickedTable()
  const urls = entries.map((e) => e[0])
  const vals = entries.map((e) => String(e[1]).slice(0, 500))
  const { rowCount } = await pool.query(
    `INSERT INTO link_title (url, title)
     SELECT u, t FROM unnest($1::text[], $2::text[]) AS x(u, t)
     ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, fetched_at = now()`,
    [urls, vals]
  )
  return rowCount ?? 0
}

// Distinct-user "unrelated" flag count per URL (for the admin links page).
export async function getUnrelatedCountsByUrl(): Promise<Record<string, number>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; n: number }>(
    `SELECT url, COUNT(*)::int AS n FROM unrelated_link GROUP BY url`
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.url] = r.n
  return out
}

// Count of links THIS user clicked today (server day, UTC), grouped by platform.
export async function getTodayClickCountsByPlatform(
  userId: string
): Promise<Record<string, number>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ platform: string | null; count: string }>(
    `SELECT platform, COUNT(*) AS count
     FROM clicked_link
     WHERE user_id = $1 AND clicked_at >= date_trunc('day', now())
     GROUP BY platform`,
    [userId]
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.platform ?? 'unknown'] = Number(r.count)
  return out
}

// Click timestamps (epoch ms) per platform within the last hour — used to seed
// the client's rolling hourly-quota tracking.
// Click timestamps (ms) per platform within the given lookback window. The
// window defaults to 1 hour but can be widened to cover the largest configured
// per-platform wait window, so the client can apply each platform's own window.
export async function getHourlyClickTimes(
  userId: string,
  lookbackMs = 60 * 60 * 1000
): Promise<Record<string, number[]>> {
  await ensureClickedTable()
  const secs = Math.max(1, Math.round(lookbackMs / 1000))
  const { rows } = await pool.query<{ platform: string; ts: string }>(
    `SELECT platform, (extract(epoch from clicked_at) * 1000)::bigint::text AS ts
     FROM clicked_link
     WHERE user_id = $1 AND clicked_at >= now() - ($2::int * interval '1 second')
     ORDER BY clicked_at`,
    [userId, secs]
  )
  const out: Record<string, number[]> = {}
  for (const r of rows) (out[r.platform] ??= []).push(Number(r.ts))
  return out
}

// How many links this user opened on a platform within `windowMs` (server-side
// cap). Defaults to the last hour.
export async function countRecentClicks(
  userId: string,
  platform: string,
  windowMs = 60 * 60 * 1000
): Promise<number> {
  await ensureClickedTable()
  const secs = Math.max(1, Math.round(windowMs / 1000))
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM clicked_link
     WHERE user_id = $1 AND platform = $2 AND clicked_at >= now() - ($3::int * interval '1 second')`,
    [userId, platform, secs]
  )
  return rows[0]?.n ?? 0
}

/**
 * Record that a user opened a link.
 *
 * `product` is the product whose COMMENT WAS SERVED for this link — the one copied
 * to the user's clipboard when they tapped Next. That is the only thing a click is
 * attributed to: users are not assigned to products, they work for all of them, so
 * there is no assignment to fall back on. A click with no served comment is stored
 * with a NULL product and counts toward no product.
 */
export async function recordClick(
  userId: string,
  url: string,
  searchQuery: string | null,
  platform: string | null,
  product?: string | null,
  servedComment?: string | null
): Promise<void> {
  await ensureClickedTable()
  const forProduct = product ?? null
  await pool.query(
    `INSERT INTO clicked_link (user_id, url, search_query, platform, product, served_comment)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, url) DO NOTHING`,
    [userId, url, searchQuery, platform, forProduct, servedComment ?? null]
  )
}

// ── Clicks inside an "only links with none of ours" session ─────────────────
// See the clean_session_click table. Only written while that setting is on, and
// wiped whenever it is switched, so it never outlives the session it belongs to.

/** Note that this user opened this link during the current ON session. */
export async function recordCleanSessionClick(userId: string, url: string): Promise<void> {
  await ensureClickedTable()
  await pool.query(
    `INSERT INTO clean_session_click (user_id, url) VALUES ($1, $2)
     ON CONFLICT (user_id, url) DO NOTHING`,
    [userId, url]
  )
}

/** What this user has opened during the current ON session. */
export async function getCleanSessionClicks(userId: string): Promise<string[]> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string }>(
    "SELECT url FROM clean_session_click WHERE user_id = $1",
    [userId]
  )
  return rows.map((r) => r.url)
}

/**
 * Start a new session: forget everything the last one recorded.
 *
 * Called on BOTH transitions. Off is the one the ask names, but clearing on the
 * way in is what actually guarantees "after the last time the button was turned
 * on" — if the setting were ever switched on twice without an off in between,
 * the old session's clicks would otherwise still be suppressing links.
 */
export async function clearCleanSessionClicks(): Promise<number> {
  await ensureClickedTable()
  const { rowCount } = await pool.query("DELETE FROM clean_session_click")
  return rowCount ?? 0
}

// ── Per-platform link limits (admin-configurable quota + wait window) ─────────

let ensuredPlatformLimit: Promise<void> | null = null

function ensurePlatformLimitTable(): Promise<void> {
  if (!ensuredPlatformLimit) {
    ensuredPlatformLimit = pool
      .query(`
        CREATE TABLE IF NOT EXISTS platform_limit (
          platform     TEXT PRIMARY KEY,
          hourly_limit INT    NOT NULL,   -- links per window; <= 0 means unlimited
          window_ms    BIGINT NOT NULL,   -- rolling window / wait time
          enabled        BOOLEAN NOT NULL DEFAULT true, -- hourly quota switch
          retire_enabled BOOLEAN NOT NULL DEFAULT true, -- link-retirement switch
          harvest_enabled BOOLEAN NOT NULL DEFAULT true, -- automatic channel extraction
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Existing installs: all default to true so nothing changes until the
        -- admin switches a platform off explicitly.
        ALTER TABLE platform_limit ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE platform_limit ADD COLUMN IF NOT EXISTS retire_enabled BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE platform_limit ADD COLUMN IF NOT EXISTS harvest_enabled BOOLEAN NOT NULL DEFAULT true;
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredPlatformLimit = null
        throw e
      })
  }
  return ensuredPlatformLimit
}

// Every platform's quota rule, filling defaults for platforms with no saved row.
export async function getPlatformLimits(): Promise<Record<string, PlatformLimit>> {
  await ensurePlatformLimitTable()
  const { rows } = await pool.query<{
    platform: string
    hourly_limit: number
    window_ms: string
    enabled: boolean
    retire_enabled: boolean
    harvest_enabled: boolean
  }>(
    `SELECT platform, hourly_limit, window_ms, enabled, retire_enabled, harvest_enabled
       FROM platform_limit`
  )
  const saved = new Map(
    rows.map((r) => [
      r.platform,
      {
        limit: r.hourly_limit,
        windowMs: Number(r.window_ms),
        enabled: r.enabled !== false,
        retireEnabled: r.retire_enabled !== false,
        harvestEnabled: r.harvest_enabled !== false,
      },
    ])
  )
  const out: Record<string, PlatformLimit> = {}
  for (const p of CLICK_PLATFORMS) out[p] = saved.get(p) ?? { ...DEFAULT_PLATFORM_LIMIT }
  return out
}

// One platform's rule (server-side click cap).
export async function getPlatformLimit(platform: string): Promise<PlatformLimit> {
  const all = await getPlatformLimits()
  return all[platform] ?? { ...DEFAULT_PLATFORM_LIMIT }
}

// ── Which product a link advertises next ────────────────────────────
//
// ONE PRODUCT PER VIDEO. Whichever of our products already leads a video's
// comment section gets every further comment on that video, so a reader sees one
// product recommended repeatedly rather than four arguing.
//
// A video with none of ours yet is assigned a product FROM THE URL, not at
// random: the same video hands every user the same product from the very first
// click, before any count exists to read. A random draw would give the first few
// concurrent clicks different products and start the video off split — exactly
// what this is meant to prevent. Across the pool the hash spreads products
// evenly, so each product ends up owning its share of videos.
//
// This REPLACES two earlier rules. It replaces the purifytext-first rule
// (config.FIRST_ON_EMPTY_PRODUCT): serving purifytext to every empty link would
// make purifytext the leader on every video and no other product would ever hold
// one. And it replaces the random draw that followed, which was chosen so that
// concurrent users got different products on the same video — the opposite of
// what is wanted now.

/**
 * Does this link already carry a given product's comment?
 *
 * TWO sources, because either alone gets it wrong:
 *
 *   • link_product_comment — what the extraction actually FOUND on the video.
 *     Proof, but only for links that have been scanned, which most have not.
 *   • clicked_link.product — what we have SERVED for the video. Not proof that
 *     anyone posted it, but it is the only signal that exists between serving a
 *     comment and the next scan finding it, which can be days.
 *
 * Without the served half, every user opening the same fresh link would be
 * handed the same product until a scan caught up: five people, five identical
 * comments on one video.
 *
 * One round trip: both EXISTS run in a single statement, and each stops at its
 * first matching row.
 */
export async function linkHasProduct(url: string, product: string): Promise<boolean> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ has: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM link_product_comment WHERE url = $1 AND product = $2)
       OR
       EXISTS (SELECT 1 FROM clicked_link WHERE url = $1 AND product = $2)
     ) AS has`,
    [url, product]
  )
  return rows[0]?.has === true
}

/**
 * How many of OUR comments the extraction found on each link, per product.
 *
 * One row per (url, product, rank) is stored, so counting the rows counts the
 * comments — a video carrying three purifytext comments reports 3, not 1.
 *
 * Only links that have been extracted appear at all. A missing url means "never
 * looked at", which is a different thing from "none found" and is shown that way.
 */
export async function getProductCommentCountsByUrl(): Promise<Record<string, Record<string, number>>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ url: string; product: string; n: number }>(
    `SELECT url, product, COUNT(*)::int AS n
       FROM link_product_comment
      GROUP BY url, product`
  )
  const out: Record<string, Record<string, number>> = {}
  for (const r of rows) {
    ;(out[r.url] ??= {})[r.product] = r.n
  }
  return out
}

/**
 * How many comments each of our products has on one link.
 *
 * TWO sources added together, for the same reason linkHasProduct reads both:
 *
 *   • link_product_comment — what a scan actually FOUND on the video. Proof,
 *     but only for links that have been scanned, and 94% never have been.
 *   • clicked_link.product — what we have SERVED for the video. Not proof that
 *     anyone posted it, but between serving a comment and the next scan finding
 *     it there is nothing else, and that gap runs to days.
 *
 * Found-only would leave almost every link at all-zero, so no product could ever
 * lead and the rule would never fire. Summing does double-count a served comment
 * that a later scan then finds — which inflates the leader, and the leader is
 * what we are trying to identify, so it pushes the right way.
 */
export async function getProductCountsForUrl(url: string): Promise<Record<string, number>> {
  await ensureClickedTable()
  const { rows } = await pool.query<{ product: string; n: number }>(
    `SELECT product, COUNT(*)::int AS n FROM (
       SELECT product FROM link_product_comment WHERE url = $1 AND product IS NOT NULL
       UNION ALL
       SELECT product FROM clicked_link WHERE url = $1 AND product IS NOT NULL
     ) t
     GROUP BY product`,
    [url]
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.product] = r.n
  return out
}

/** Stable 32-bit hash of a string — same URL, same number, every process. */
function hashUrl(url: string): number {
  let h = 2166136261
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Pick the product whose comment should be served next for `url`.
 *
 * The product already leading this video's comment section, so one product
 * dominates it. With nothing on the video yet, the URL itself decides — see the
 * note above this section for why that is a hash and not a draw.
 *
 * A product that is no longer active is ignored even if it leads, or an admin
 * turning a product off would leave every video it owns stuck on it.
 *
 * Returns null only when there are no products to choose from.
 */
export async function pickFairProductForUrl(
  url: string,
  products: readonly string[]
): Promise<string | null> {
  if (products.length === 0) return null

  // Ordered, so the hash maps a URL to the same product on every call. The
  // active list arrives in whatever order the query returned it.
  const active = [...products].sort()

  // A read failure must not silently reshuffle a video that already has a
  // leader, so it falls through to the hash — which at least keeps every user
  // of that video on one product, the same one, until the database is back.
  const counts = await getProductCountsForUrl(url).catch(() => ({}) as Record<string, number>)

  let best: string | null = null
  let bestN = 0
  for (const p of active) {
    const n = counts[p] ?? 0
    // Strictly greater: on a tie the earlier product in the sorted list holds
    // the lead rather than the two swapping back and forth.
    if (n > bestN) {
      best = p
      bestN = n
    }
  }
  if (best) return best

  return active[hashUrl(url) % active.length] ?? null
}

// ── Effective enforcement ────────────────────────────────────────────────────
// TWO INDEPENDENT RULES, each with its OWN per-platform switch and nothing else.
// There is no master switch: a platform's behaviour depends only on its own row.
//
//   • HOURLY QUOTA (N links per rolling window) — on when that platform's
//     `enabled` switch is on.
//   • LINK RETIREMENT (a link leaving the pool once enough distinct users have
//     clicked it) — on when that platform's `retireEnabled` switch is on.
//
// Everything that enforces either rule goes through here so the split is applied
// in exactly one place.

export interface EffectiveLimits {
  /** Per-platform rule with `limit` forced to 0 (unlimited) where not enforced. */
  limits: Record<string, PlatformLimit>
  /** Platforms whose HOURLY quota is active right now. */
  enforced: Set<string>
  /** Platforms whose links retire right now. */
  retirePlatforms: Set<string>
}

export async function getEffectivePlatformLimits(): Promise<EffectiveLimits> {
  const raw = await getPlatformLimits().catch(() => ({}) as Record<string, PlatformLimit>)
  const limits: Record<string, PlatformLimit> = {}
  const enforced = new Set<string>()
  const retirePlatforms = new Set<string>()
  for (const [p, rule] of Object.entries(raw)) {
    const hourlyOn = rule.enabled !== false
    if (hourlyOn) enforced.add(p)
    if (rule.retireEnabled !== false) retirePlatforms.add(p)
    // Hourly not enforced → advertise it as unlimited so nothing downstream locks.
    limits[p] = { ...rule, limit: hourlyOn ? rule.limit : 0 }
  }
  return { limits, enforced, retirePlatforms }
}

// One platform's effective HOURLY rule, plus whether it's actually enforced.
// Used by the click endpoints before recording a click. Deliberately does NOT
// consult the master switch — that one only governs retirement.
export async function getEffectivePlatformLimit(
  platform: string
): Promise<PlatformLimit & { enforced: boolean }> {
  const rule = await getPlatformLimit(platform)
  const enforced = rule.enabled !== false
  return { ...rule, limit: enforced ? rule.limit : 0, enforced }
}


// Save one platform's quota + wait window. Its two switches are left untouched
// (use setPlatformEnabled / setPlatformRetireEnabled for those).
export async function setPlatformLimit(platform: string, limit: number, windowMs: number): Promise<void> {
  await ensurePlatformLimitTable()
  const lim = Math.trunc(Number(limit))
  const win = Math.max(1000, Math.trunc(Number(windowMs)))
  await pool.query(
    `INSERT INTO platform_limit
       (platform, hourly_limit, window_ms, enabled, retire_enabled, harvest_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (platform) DO UPDATE SET
       hourly_limit = EXCLUDED.hourly_limit,
       window_ms    = EXCLUDED.window_ms,
       updated_at   = now()`,
    [
      platform,
      Number.isFinite(lim) ? lim : DEFAULT_PLATFORM_LIMIT.limit,
      win,
      DEFAULT_PLATFORM_LIMIT.enabled,
      DEFAULT_PLATFORM_LIMIT.retireEnabled,
      DEFAULT_PLATFORM_LIMIT.harvestEnabled,
    ]
  )
}

// Flip ONE of a platform's two switches, independently of the others and of the
// other switch. Inserts the platform's default rule first if it has never been
// saved, so a flag can be flipped before any limit is chosen.
async function setPlatformFlag(
  platform: string,
  column: 'enabled' | 'retire_enabled' | 'harvest_enabled',
  value: boolean
): Promise<void> {
  await ensurePlatformLimitTable()
  // `column` is a literal from the union above, never caller input.
  await pool.query(
    `INSERT INTO platform_limit
       (platform, hourly_limit, window_ms, enabled, retire_enabled, harvest_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (platform) DO UPDATE SET
       ${column}  = EXCLUDED.${column},
       updated_at = now()`,
    [
      platform,
      DEFAULT_PLATFORM_LIMIT.limit,
      DEFAULT_PLATFORM_LIMIT.windowMs,
      column === 'enabled' ? value : DEFAULT_PLATFORM_LIMIT.enabled,
      column === 'retire_enabled' ? value : DEFAULT_PLATFORM_LIMIT.retireEnabled,
      column === 'harvest_enabled' ? value : DEFAULT_PLATFORM_LIMIT.harvestEnabled,
    ]
  )
}

/** Turn one platform's HOURLY quota on/off. */
export async function setPlatformEnabled(platform: string, enabled: boolean): Promise<void> {
  await setPlatformFlag(platform, 'enabled', enabled)
}

/** Turn one platform's LINK RETIREMENT on/off (still gated by the master switch). */
export async function setPlatformRetireEnabled(platform: string, enabled: boolean): Promise<void> {
  await setPlatformFlag(platform, 'retire_enabled', enabled)
}

/** Turn one platform's AUTOMATIC CHANNEL EXTRACTION on/off. */
export async function setPlatformHarvestEnabled(
  platform: string,
  enabled: boolean
): Promise<void> {
  await setPlatformFlag(platform, 'harvest_enabled', enabled)
}

/**
 * The click platforms whose channels the automatic harvest may visit.
 *
 * Read on every harvest slice rather than cached: the switch has to take effect
 * on the next tick, not the next deploy.
 */
export async function getHarvestPlatforms(): Promise<Set<string>> {
  const all = await getPlatformLimits().catch(() => ({}) as Record<string, PlatformLimit>)
  const out = new Set<string>()
  for (const [p, rule] of Object.entries(all)) if (rule.harvestEnabled !== false) out.add(p)
  return out
}

// ── User profile / onboarding ────────────────────────────────────────────────
// NOTE: bank_account is sensitive PII. Lock down DB access and consider
// encrypting it at rest (see the app owner's security review).

let ensuredProfile: Promise<void> | null = null

export function ensureUserProfileTable(): Promise<void> {
  if (!ensuredProfile) {
    ensuredProfile = pool
      .query(`
        CREATE TABLE IF NOT EXISTS user_profile (
          user_id       TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          bank_account  TEXT NOT NULL,
          tiktok_url    TEXT,
          youtube_url   TEXT,
          instagram_url TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Normalised copies of each profile link, used to enforce that no two
        -- users register the same account. NULL when the user left it blank.
        ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS tiktok_url_norm    TEXT;
        ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS youtube_url_norm   TEXT;
        ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS instagram_url_norm TEXT;
      `)
      .then(async () => {
        // Unique indexes are the race-safe guarantee. They live in a separate
        // step because CREATE UNIQUE INDEX fails if pre-existing rows already
        // collide — in that case we fall back to the app-level check alone and
        // don't want the whole table-ensure to brick.
        for (const [col, idx] of [
          ['tiktok_url_norm', 'uq_profile_tiktok'],
          ['youtube_url_norm', 'uq_profile_youtube'],
          ['instagram_url_norm', 'uq_profile_instagram'],
        ] as const) {
          try {
            await pool.query(
              `CREATE UNIQUE INDEX IF NOT EXISTS ${idx}
               ON user_profile (${col}) WHERE ${col} IS NOT NULL`
            )
          } catch {
            /* pre-existing duplicates — app-level check still enforces it */
          }
        }
      })
      .then(() => undefined)
      .catch((e) => {
        ensuredProfile = null
        throw e
      })
  }
  return ensuredProfile
}

export interface UserProfile {
  name: string
  bank_account: string
  tiktok_url: string | null
  youtube_url: string | null
  instagram_url: string | null
}

/**
 * Canonicalise a profile URL for uniqueness comparison: lowercased, without
 * protocol / leading "www." / query string / fragment / trailing slash. So
 * "https://www.tiktok.com/@You/?lang=en" and "tiktok.com/@you" collide.
 * Returns null for blank input.
 */
export function normalizeProfileUrl(raw: string | null | undefined): string | null {
  let s = String(raw ?? '').trim()
  if (!s) return null
  s = s.toLowerCase()
  s = s.replace(/^https?:\/\//, '')
  s = s.replace(/^www\./, '')
  s = s.split(/[?#]/)[0]
  s = s.replace(/\/+$/, '')
  return s || null
}

// Which of the given links are already registered by a *different* user.
// Returns the list of platform names that collide (empty = all clear).
export async function findProfileLinkConflicts(
  userId: string,
  p: Pick<UserProfile, 'tiktok_url' | 'youtube_url' | 'instagram_url'>
): Promise<Array<'TikTok' | 'YouTube' | 'Instagram'>> {
  await ensureUserProfileTable()
  const tk = normalizeProfileUrl(p.tiktok_url)
  const yt = normalizeProfileUrl(p.youtube_url)
  const ig = normalizeProfileUrl(p.instagram_url)
  const { rows } = await pool.query<{ tiktok: boolean; youtube: boolean; instagram: boolean }>(
    `SELECT
       EXISTS(SELECT 1 FROM user_profile WHERE user_id <> $1 AND tiktok_url_norm    = $2) AS tiktok,
       EXISTS(SELECT 1 FROM user_profile WHERE user_id <> $1 AND youtube_url_norm   = $3) AS youtube,
       EXISTS(SELECT 1 FROM user_profile WHERE user_id <> $1 AND instagram_url_norm = $4) AS instagram`,
    [userId, tk, yt, ig]
  )
  const r = rows[0]
  const out: Array<'TikTok' | 'YouTube' | 'Instagram'> = []
  if (r?.tiktok) out.push('TikTok')
  if (r?.youtube) out.push('YouTube')
  if (r?.instagram) out.push('Instagram')
  return out
}

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  await ensureUserProfileTable()
  const { rows } = await pool.query<UserProfile>(
    `SELECT name, bank_account, tiktok_url, youtube_url, instagram_url
     FROM user_profile WHERE user_id = $1`,
    [userId]
  )
  return rows[0] ?? null
}

// Thrown when a profile link is already registered by another user. The route
// turns this into a friendly 409 instead of a generic 500.
export class ProfileLinkConflictError extends Error {
  platforms: string[]
  constructor(platforms: string[]) {
    super(`Profile link already in use: ${platforms.join(', ')}`)
    this.name = 'ProfileLinkConflictError'
    this.platforms = platforms
  }
}

export async function upsertUserProfile(userId: string, p: UserProfile): Promise<void> {
  await ensureUserProfileTable()
  const tkN = normalizeProfileUrl(p.tiktok_url)
  const ytN = normalizeProfileUrl(p.youtube_url)
  const igN = normalizeProfileUrl(p.instagram_url)
  try {
    await pool.query(
      `INSERT INTO user_profile
         (user_id, name, bank_account, tiktok_url, youtube_url, instagram_url,
          tiktok_url_norm, youtube_url_norm, instagram_url_norm, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (user_id) DO UPDATE SET
         name               = EXCLUDED.name,
         bank_account       = EXCLUDED.bank_account,
         tiktok_url         = EXCLUDED.tiktok_url,
         youtube_url        = EXCLUDED.youtube_url,
         instagram_url      = EXCLUDED.instagram_url,
         tiktok_url_norm    = EXCLUDED.tiktok_url_norm,
         youtube_url_norm   = EXCLUDED.youtube_url_norm,
         instagram_url_norm = EXCLUDED.instagram_url_norm,
         updated_at         = now()`,
      [userId, p.name, p.bank_account, p.tiktok_url, p.youtube_url, p.instagram_url,
       tkN, ytN, igN]
    )
  } catch (e) {
    // Race-safety net: a concurrent registration slipped a duplicate past the
    // app-level check, so a unique index rejected it (Postgres 23505).
    const code = (e as { code?: string })?.code
    const constraint = (e as { constraint?: string })?.constraint ?? ''
    if (code === '23505') {
      const platforms: string[] = []
      if (constraint.includes('tiktok')) platforms.push('TikTok')
      else if (constraint.includes('youtube')) platforms.push('YouTube')
      else if (constraint.includes('instagram')) platforms.push('Instagram')
      throw new ProfileLinkConflictError(platforms.length ? platforms : ['a profile link'])
    }
    throw e
  }
}

// A profile counts as "complete" once name + bank account are filled in.
export function isProfileComplete(p: UserProfile | null): boolean {
  // TikTok is required; YouTube and Instagram are optional.
  return (
    !!p &&
    p.name.trim().length > 0 &&
    p.bank_account.trim().length > 0 &&
    !!p.tiktok_url?.trim()
  )
}

// ── Blocked users ────────────────────────────────────────────────────────────
// A blocked user can no longer sign in. There are three block reasons:
//   • 'bank'    — incorrect bank account. On next sign-in the user is asked for a
//                 NEW bank account number; entering a different one auto-unblocks.
//   • 'tiktok'  — TikTok account visibility restricted. On next sign-in the user
//                 is asked for a NEW TikTok profile link; a different one unblocks.
//   • 'forever' — hard block. No self-service path; only an admin can unblock.
// The blocked identifiers (email + bank / TikTok, depending on reason) are also
// barred from re-registration under any account. Rows persist even after the
// underlying user is deleted.

export type BlockReason = 'bank' | 'tiktok' | 'forever'
export function isBlockReason(v: unknown): v is BlockReason {
  return v === 'bank' || v === 'tiktok' || v === 'forever'
}

export interface BlockInfo {
  userId: string | null
  reason: BlockReason
  bankNorm: string | null
  tiktokNorm: string | null
  /** Decided by the nightly presence check rather than by a person. The screen
   *  a user sees says something different in that case — a machine's reading of
   *  their account is a thing they can answer. */
  auto: boolean
}

// Canonicalise a bank account number for matching: strip whitespace, lowercase.
export function normalizeBank(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').replace(/\s+/g, '').toLowerCase()
  return s || null
}

let ensuredBlocked: Promise<void> | null = null

export function ensureBlockedUserTable(): Promise<void> {
  if (!ensuredBlocked) {
    ensuredBlocked = pool
      .query(`
        CREATE TABLE IF NOT EXISTS blocked_user (
          id          BIGSERIAL PRIMARY KEY,
          user_id     TEXT,
          email       TEXT,        -- lowercased sign-in email
          bank_norm   TEXT,        -- normalised bank account number
          tiktok_norm TEXT,        -- normalised TikTok profile link
          name        TEXT,
          reason      TEXT NOT NULL DEFAULT 'forever',  -- bank | tiktok | forever
          blocked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- Was this block decided by the nightly comment-presence check rather
        -- than by a person? The reason says WHY; this says WHO, and the two are
        -- different questions — an automatic block is a machine's opinion and
        -- deserves a second look before it is treated as final.
        ALTER TABLE blocked_user ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE blocked_user ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'forever';
        CREATE INDEX IF NOT EXISTS idx_blocked_email  ON blocked_user (email)       WHERE email       IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_blocked_bank   ON blocked_user (bank_norm)   WHERE bank_norm   IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_blocked_tiktok ON blocked_user (tiktok_norm) WHERE tiktok_norm IS NOT NULL;
        -- Users an admin has unblocked by hand. The presence check may block
        -- automatically, but it must never overturn a person's decision: without
        -- this, unblocking someone the check still disagrees with just means they
        -- are blocked again on the next sweep, and the admin cannot win.
        CREATE TABLE IF NOT EXISTS auto_block_exempt (
          user_id     TEXT PRIMARY KEY,
          exempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredBlocked = null
        throw e
      })
  }
  return ensuredBlocked
}

// Block a user with a reason. Only the identifiers relevant to the reason are
// stored (so the correctable reasons key on exactly the field the user must
// change): 'bank' → bank; 'tiktok' → TikTok; 'forever' → both. Email is always
// stored (that's how sign-in is blocked). Signs them out immediately.
export async function blockUser(
  userId: string,
  reason: BlockReason = 'forever',
  auto = false
): Promise<void> {
  await ensureBlockedUserTable()
  const [info, profile] = await Promise.all([
    getUserNameEmail(userId).catch(() => null),
    getUserProfile(userId).catch(() => null),
  ])
  const email = (info?.email || '').trim().toLowerCase() || null
  const bankAll = normalizeBank(profile?.bank_account)
  const tiktokAll = normalizeProfileUrl(profile?.tiktok_url)
  const name = (profile?.name || info?.name || '').trim() || null

  const bank = reason === 'bank' || reason === 'forever' ? bankAll : null
  const tiktok = reason === 'tiktok' || reason === 'forever' ? tiktokAll : null

  // Idempotent: replace any prior block row for this user id.
  await pool.query('DELETE FROM blocked_user WHERE user_id = $1', [userId]).catch(() => {})
  await pool.query(
    `INSERT INTO blocked_user (user_id, email, bank_norm, tiktok_norm, name, reason, auto)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, email, bank, tiktok, name, reason, auto]
  )
  // Sign them out now (any current web sessions).
  await pool.query('DELETE FROM session WHERE "userId" = $1', [userId]).catch(() => {})
  // Revoke the native app token too, if any.
  await pool.query('DELETE FROM app_token WHERE user_id = $1', [userId]).catch(() => {})
}

// Unblock a user: clear rows by their user id AND their current email (covers a
// row that was captured before a delete/re-register).
export async function unblockUser(userId: string): Promise<void> {
  await ensureBlockedUserTable()
  const info = await getUserNameEmail(userId).catch(() => null)
  const email = (info?.email || '').trim().toLowerCase() || null
  await pool.query(
    'DELETE FROM blocked_user WHERE user_id = $1 OR (email IS NOT NULL AND email = $2)',
    [userId, email]
  )
  // An admin has looked at this person and decided. The automatic check does not
  // get to reverse that on its next run.
  await pool
    .query(
      'INSERT INTO auto_block_exempt (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    )
    .catch(() => {})
}

/**
 * May the presence check block this user by itself?
 *
 * False when they are already blocked (re-blocking would only resend the same
 * message) or when an admin has unblocked them at least once. Errs to FALSE on
 * a database failure: not blocking someone who deserved it is a smaller mistake
 * than blocking someone who did not.
 */
export async function canAutoBlock(userId: string): Promise<boolean> {
  await ensureBlockedUserTable()
  const { rows } = await pool.query<{ blocked: boolean; exempt: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM blocked_user WHERE user_id = $1) AS blocked,
            EXISTS (SELECT 1 FROM auto_block_exempt WHERE user_id = $1) AS exempt`,
    [userId]
  )
  const r = rows[0]
  return !!r && !r.blocked && !r.exempt
}

// Remove the block row(s) for this email (used after successful self-remediation).
export async function clearBlockByEmail(email: string | null | undefined): Promise<void> {
  const e = (email || '').trim().toLowerCase()
  if (!e) return
  await ensureBlockedUserTable()
  await pool.query('DELETE FROM blocked_user WHERE email = $1', [e])
}

// The block on this sign-in email, or null. Includes the reason + the exact
// identifiers the user must change to self-unblock.
export async function getBlockForEmail(email: string | null | undefined): Promise<BlockInfo | null> {
  const e = (email || '').trim().toLowerCase()
  if (!e) return null
  await ensureBlockedUserTable()
  const { rows } = await pool.query<{
    user_id: string | null
    reason: string
    bank_norm: string | null
    tiktok_norm: string | null
    auto: boolean
  }>(
    `SELECT user_id, reason, bank_norm, tiktok_norm, auto
     FROM blocked_user WHERE email = $1
     ORDER BY blocked_at DESC LIMIT 1`,
    [e]
  )
  const r = rows[0]
  if (!r) return null
  return {
    userId: r.user_id,
    reason: isBlockReason(r.reason) ? r.reason : 'forever',
    bankNorm: r.bank_norm,
    tiktokNorm: r.tiktok_norm,
    auto: r.auto === true,
  }
}

// Is this sign-in email blocked? (thin boolean wrapper over getBlockForEmail)
export async function isEmailBlocked(email: string | null | undefined): Promise<boolean> {
  return (await getBlockForEmail(email)) !== null
}

// For registration: which of email / bank account / TikTok link are blocked.
// Returns human-readable labels (empty = all clear).
export async function findBlockedRegistration(p: {
  email?: string | null
  bank_account?: string | null
  tiktok_url?: string | null
}): Promise<string[]> {
  await ensureBlockedUserTable()
  const email = (p.email || '').trim().toLowerCase() || null
  const bank = normalizeBank(p.bank_account)
  const tiktok = normalizeProfileUrl(p.tiktok_url)
  const { rows } = await pool.query<{ by_email: boolean; by_bank: boolean; by_tiktok: boolean }>(
    `SELECT
       EXISTS(SELECT 1 FROM blocked_user WHERE email       IS NOT NULL AND email       = $1) AS by_email,
       EXISTS(SELECT 1 FROM blocked_user WHERE bank_norm   IS NOT NULL AND bank_norm   = $2) AS by_bank,
       EXISTS(SELECT 1 FROM blocked_user WHERE tiktok_norm IS NOT NULL AND tiktok_norm = $3) AS by_tiktok`,
    [email, bank, tiktok]
  )
  const r = rows[0]
  const out: string[] = []
  if (r?.by_email) out.push('email')
  if (r?.by_bank) out.push('bank account')
  if (r?.by_tiktok) out.push('TikTok link')
  return out
}

// Every blocked sign-in email → its reason (for the admin list's blocked badge).
export async function getBlockedByEmail(): Promise<Map<string, { reason: BlockReason; auto: boolean }>> {
  await ensureBlockedUserTable()
  const { rows } = await pool.query<{ email: string | null; reason: string; auto: boolean }>(
    'SELECT email, reason, auto FROM blocked_user WHERE email IS NOT NULL'
  )
  const out = new Map<string, { reason: BlockReason; auto: boolean }>()
  for (const r of rows) {
    const e = (r.email || '').toLowerCase()
    if (e) out.set(e, { reason: isBlockReason(r.reason) ? r.reason : 'forever', auto: !!r.auto })
  }
  return out
}

// ── Admin / reset / activity / commented submissions ─────────────────────────

let ensuredAdmin: Promise<void> | null = null

export function ensureAdminTables(): Promise<void> {
  if (!ensuredAdmin) {
    ensuredAdmin = pool
      .query(`
        CREATE TABLE IF NOT EXISTS app_state (
          id       INT PRIMARY KEY DEFAULT 1,
          reset_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
          CHECK (id = 1)
        );
        INSERT INTO app_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
        -- Global on/off for the 150-birr video task (admin controlled).
        ALTER TABLE app_state ADD COLUMN IF NOT EXISTS video_task_enabled BOOLEAN NOT NULL DEFAULT true;
        -- Global on/off for the repost ("Repost & earn") task. Defaults ON so
        -- adding the column doesn't silently switch a running task off.
        ALTER TABLE app_state ADD COLUMN IF NOT EXISTS promo_task_enabled BOOLEAN NOT NULL DEFAULT true;

        -- Per-product comment length band. Admin-editable; the generator asks for
        -- a spread of lengths inside it and anything outside is discarded.
        CREATE TABLE IF NOT EXISTS product_comment_setting (
          product    TEXT PRIMARY KEY,
          word_min   INT NOT NULL,
          word_max   INT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- How a comment is written, per product. Defaults match what the
        -- generator did before these were settable, so an existing row keeps
        -- producing exactly what it produced yesterday.
        ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS emoji BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS split_brand BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS quote_brand BOOLEAN NOT NULL DEFAULT true;
        -- Question style vs plain statements. Defaults TRUE because that is what
        -- the generator was switched to; a row written before this column existed
        -- picks it up as well, which is intended - the two styles are a choice to
        -- try, not a migration to preserve.
        ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS question BOOLEAN NOT NULL DEFAULT true;
        -- Which of the three pitches a comment makes. Replaces the question
        -- boolean above, which is left in place so a rollback still reads a
        -- sane value; the backfill below carries whatever it was set to.
        ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS voice TEXT NOT NULL DEFAULT 'question';
        UPDATE product_comment_setting SET voice = CASE WHEN question THEN 'question' ELSE 'recommendation' END
         WHERE voice IS NULL OR voice NOT IN ('question','recommendation','informational','curious');
        -- The system prompt, when an admin has edited it on the comments page.
        -- NULL means "build it from the settings", which is the normal case.
        ALTER TABLE product_comment_setting ADD COLUMN IF NOT EXISTS prompt TEXT;
        -- JSON array of products whose comments feed the app's comment pool (admin
        -- controlled). NULL = default to all non-deactivated products.
        ALTER TABLE app_state ADD COLUMN IF NOT EXISTS active_comment_products TEXT;
        -- JSON {recency,isVideo,hearts} for the posted-date cluster score, set
        -- from the Recluster modal. NULL = use the compiled defaults in config.
        ALTER TABLE app_state ADD COLUMN IF NOT EXISTS date_weights TEXT;
        -- Word band for generated REPLY drafts. Separate from the per-product
        -- comment band: a reply answers a comment first and needs more room
        -- than a drive-by product mention.
        ALTER TABLE app_state ADD COLUMN IF NOT EXISTS reply_word_min INT;
        ALTER TABLE app_state ADD COLUMN IF NOT EXISTS reply_word_max INT;
        -- LEGACY: the old global quota master switch. No longer read or written —
        -- enforcement is per platform (platform_limit.enabled / .retire_enabled).
        -- Kept so existing rows/deploys don't break; safe to drop manually.
        ALTER TABLE app_state ADD COLUMN IF NOT EXISTS quota_enabled BOOLEAN NOT NULL DEFAULT false;

        -- Single-row store for globally-shared downloadable assets (the Android
        -- APK the admin uploads). Keyed so we can add more asset kinds later.
        CREATE TABLE IF NOT EXISTS app_asset (
          key          TEXT PRIMARY KEY,
          url          TEXT NOT NULL,
          filename     TEXT,
          size         BIGINT,
          version      TEXT,
          version_code INT,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE app_asset ADD COLUMN IF NOT EXISTS version_code INT;

        -- Which app version each user is currently running (reported by the app).
        CREATE TABLE IF NOT EXISTS user_app (
          user_id      TEXT PRIMARY KEY,
          version_name TEXT,
          version_code INT,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS user_login_day (
          user_id TEXT NOT NULL,
          day     DATE NOT NULL,
          PRIMARY KEY (user_id, day)
        );

        CREATE TABLE IF NOT EXISTS user_reset (
          user_id  TEXT PRIMARY KEY,
          reset_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_product (
          user_id    TEXT PRIMARY KEY,
          product    TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS video_access (
          user_id      TEXT PRIMARY KEY,
          status       TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
          requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          decided_at   TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS video_submission (
          id          BIGSERIAL PRIMARY KEY,
          user_id     TEXT NOT NULL,
          url         TEXT NOT NULL,
          filename    TEXT,
          size        BIGINT,
          paid        BOOLEAN NOT NULL DEFAULT false,
          uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE video_submission ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;
        -- Per-submission review: pending (awaiting admin) | approved | rejected.
        ALTER TABLE video_submission ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE video_submission ADD COLUMN IF NOT EXISTS reject_reason TEXT;
        -- Backfill: anything already paid was implicitly accepted.
        UPDATE video_submission SET status = 'approved' WHERE paid = true AND status = 'pending';

        -- Mailbox task: an address a worker created on the company's own
        -- domain. Reviewed per submission, exactly like video_submission:
        -- pending (awaiting an admin checking it exists) | approved | rejected.
        CREATE TABLE IF NOT EXISTS account_submission (
          id            BIGSERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          email         TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'pending',
          reject_reason TEXT,
          paid          BOOLEAN NOT NULL DEFAULT false,
          submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          reviewed_at   TIMESTAMPTZ,
          reviewed_by   TEXT
        );
        -- One address, one payment. Without this two workers can submit the
        -- same address and both be paid for it, and the second submission is
        -- not work — it is a copy of someone else's.
        CREATE UNIQUE INDEX IF NOT EXISTS account_submission_email_key
          ON account_submission (lower(email));
        CREATE INDEX IF NOT EXISTS account_submission_user_idx
          ON account_submission (user_id, submitted_at DESC);

        CREATE TABLE IF NOT EXISTS admin_message (
          id             BIGSERIAL PRIMARY KEY,
          target_user_id TEXT,  -- NULL = broadcast to all users
          body           TEXT NOT NULL,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS message_read (
          message_id BIGINT NOT NULL,
          user_id    TEXT NOT NULL,
          read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (message_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS message_reply (
          id         BIGSERIAL PRIMARY KEY,
          message_id BIGINT NOT NULL,
          user_id    TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS commented_submission (
          id           BIGSERIAL PRIMARY KEY,
          user_id      TEXT NOT NULL,
          platform     TEXT NOT NULL,
          count        INT  NOT NULL,
          sample_url   TEXT,
          submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE commented_submission ADD COLUMN IF NOT EXISTS sample_url TEXT;

        CREATE TABLE IF NOT EXISTS comment_screenshot (
          id          BIGSERIAL PRIMARY KEY,
          user_id     TEXT NOT NULL,
          platform    TEXT NOT NULL,
          blob_url    TEXT NOT NULL,
          uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        -- When the admin approves/pays a user's comment earnings, we stamp the
        -- time here. Pending comment pay only counts comments after this stamp.
        CREATE TABLE IF NOT EXISTS comment_pay_marker (
          user_id TEXT PRIMARY KEY,
          paid_at TIMESTAMPTZ NOT NULL
        );

        -- Pay workflow: approved_at set when admin approves; when marked paid we
        -- record the amount + reset paid_ack so the user sees it once on next login.
        CREATE TABLE IF NOT EXISTS user_pay_status (
          user_id          TEXT PRIMARY KEY,
          approved_at      TIMESTAMPTZ,
          approved_amount  NUMERIC,      -- total birr snapshot at approval time
          last_paid_amount NUMERIC,
          last_paid_at     TIMESTAMPTZ,
          paid_ack         BOOLEAN NOT NULL DEFAULT false
        );
        -- Backfill the column for databases created before it existed.
        ALTER TABLE user_pay_status ADD COLUMN IF NOT EXISTS approved_amount NUMERIC;

        -- Long-lived per-user tokens for the native "Next bubble" Android app,
        -- minted after the user signs in with Google in the browser.
        CREATE TABLE IF NOT EXISTS app_token (
          token        TEXT PRIMARY KEY,
          user_id      TEXT NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS app_token_user_idx ON app_token (user_id);
        -- Video guides shown on the (public) /guide page. A list rather than a
        -- single asset: the guide covers several tasks, and each gets its own
        -- clip. The position column orders them; lang is a hint shown on the
        -- card, not a filter, so a clip is never hidden from someone who needs it.
        CREATE TABLE IF NOT EXISTS guide_video (
          id         SERIAL PRIMARY KEY,
          url        TEXT NOT NULL,
          filename   TEXT,
          size       BIGINT,
          title      TEXT NOT NULL DEFAULT '',
          note       TEXT NOT NULL DEFAULT '',
          lang       TEXT NOT NULL DEFAULT '',
          position   INT  NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS guide_video_pos_idx ON guide_video (position, id);
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredAdmin = null
        throw e
      })
  }
  return ensuredAdmin
}

export async function getResetAt(): Promise<Date> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ reset_at: Date }>('SELECT reset_at FROM app_state WHERE id = 1')
  return rows[0]?.reset_at ?? new Date(0)
}

// Global on/off for the 150-birr video task (admin controlled).
export async function getVideoTaskEnabled(): Promise<boolean> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ video_task_enabled: boolean }>(
    'SELECT video_task_enabled FROM app_state WHERE id = 1'
  )
  return rows[0]?.video_task_enabled ?? true
}

export async function setVideoTaskEnabled(enabled: boolean): Promise<void> {
  await ensureAdminTables()
  await pool.query('UPDATE app_state SET video_task_enabled = $1 WHERE id = 1', [enabled])
}

// Global on/off for the repost ("Repost & earn") task (admin controlled).
export async function getPromoTaskEnabled(): Promise<boolean> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ promo_task_enabled: boolean }>(
    'SELECT promo_task_enabled FROM app_state WHERE id = 1'
  )
  return rows[0]?.promo_task_enabled ?? true
}

export async function setPromoTaskEnabled(enabled: boolean): Promise<void> {
  await ensureAdminTables()
  await pool.query('UPDATE app_state SET promo_task_enabled = $1 WHERE id = 1', [enabled])
}

// ── Per-product comment length band ─────────────────────────────────────────
// How long a generated comment may be, per product. Unset products fall back to
// the COMMENT_WORD_MIN/MAX defaults, so this table only holds real overrides.

export interface WordBand {
  min: number
  max: number
}

/** Clamp an admin-supplied band to something a comment generator can satisfy. */
export function normaliseWordBand(min: unknown, max: unknown, dflt: WordBand): WordBand {
  // A blank field means "leave it alone", not 0 — Number('') is 0, which would
  // otherwise silently clamp an empty min box down to 1.
  const num = (v: unknown): number => (v === '' || v == null ? NaN : Math.round(Number(v)))
  const lo = num(min)
  const hi = num(max)
  const okLo = Number.isFinite(lo) ? Math.min(Math.max(lo, 1), 60) : dflt.min
  const okHi = Number.isFinite(hi) ? Math.min(Math.max(hi, 1), 60) : dflt.max
  // A reversed band would reject every rewrite, so order it rather than error.
  return okLo <= okHi ? { min: okLo, max: okHi } : { min: okHi, max: okLo }
}

export async function getProductWordBands(): Promise<Record<string, WordBand>> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ product: string; word_min: number; word_max: number }>(
    'SELECT product, word_min, word_max FROM product_comment_setting'
  )
  const out: Record<string, WordBand> = {}
  for (const r of rows) out[r.product] = { min: r.word_min, max: r.word_max }
  return out
}

export async function getProductWordBand(product: string, dflt: WordBand): Promise<WordBand> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ word_min: number; word_max: number }>(
    'SELECT word_min, word_max FROM product_comment_setting WHERE product = $1',
    [product]
  )
  const r = rows[0]
  return r ? { min: r.word_min, max: r.word_max } : dflt
}

/** Band and writing style together — one row, one query, one round trip. */
export async function getProductCommentSettings(
  product: string,
  dflt: WordBand
): Promise<{ band: WordBand; style: CommentStyle }> {
  await ensureAdminTables()
  const { rows } = await pool.query<{
    word_min: number
    word_max: number
    emoji: boolean
    split_brand: boolean
    quote_brand: boolean
    voice: string
  }>(
    `SELECT word_min, word_max, emoji, split_brand, quote_brand, voice
       FROM product_comment_setting WHERE product = $1`,
    [product]
  )
  const r = rows[0]
  if (!r) return { band: dflt, style: DEFAULT_COMMENT_STYLE }
  return {
    band: { min: r.word_min, max: r.word_max },
    style: {
      emoji: r.emoji,
      splitBrand: r.split_brand,
      quoteBrand: r.quote_brand,
      voice: isCommentVoice(r.voice) ? r.voice : DEFAULT_COMMENT_STYLE.voice,
    },
  }
}

/** The admin's edited system prompt for this product, or null to use the built one. */
export async function getProductPrompt(product: string): Promise<string | null> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ prompt: string | null }>(
    'SELECT prompt FROM product_comment_setting WHERE product = $1',
    [product]
  )
  const p = rows[0]?.prompt
  return p && p.trim() ? p : null
}

/** Save an edited prompt, or clear it (null / blank) to go back to the built one. */
export async function setProductPrompt(product: string, prompt: string | null): Promise<void> {
  await ensureAdminTables()
  const value = prompt && prompt.trim() ? prompt.trim() : null
  await pool.query(
    `INSERT INTO product_comment_setting (product, word_min, word_max, prompt, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (product) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = now()`,
    [product, COMMENT_WORD_MIN, COMMENT_WORD_MAX, value]
  )
}

export async function setProductCommentStyle(product: string, style: CommentStyle): Promise<void> {
  await ensureAdminTables()
  // The row may not exist yet — a product whose band was never touched still
  // needs somewhere to put the style, so this inserts the defaults alongside it.
  await pool.query(
    `INSERT INTO product_comment_setting (product, word_min, word_max, emoji, split_brand, quote_brand, voice, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (product) DO UPDATE SET
       emoji = EXCLUDED.emoji,
       split_brand = EXCLUDED.split_brand,
       quote_brand = EXCLUDED.quote_brand,
       voice = EXCLUDED.voice,
       updated_at = now()`,
    [product, COMMENT_WORD_MIN, COMMENT_WORD_MAX, style.emoji, style.splitBrand, style.quoteBrand,
     style.voice]
  )
}

export async function setProductWordBand(product: string, band: WordBand): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    `INSERT INTO product_comment_setting (product, word_min, word_max, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (product) DO UPDATE SET
       word_min = EXCLUDED.word_min, word_max = EXCLUDED.word_max, updated_at = now()`,
    [product, band.min, band.max]
  )
}

// Products whose comments feed the app's comment pool. Defaults to every
// non-deactivated product when the admin hasn't chosen a subset.
export async function getActiveCommentProducts(): Promise<string[]> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ v: string | null }>(
    'SELECT active_comment_products AS v FROM app_state WHERE id = 1'
  )
  const raw = rows[0]?.v
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        const clean = arr.filter((x): x is string => typeof x === 'string' && isProduct(x))
        // An explicitly-saved empty list is respected (no products active).
        return clean
      }
    } catch {
      /* fall through to default */
    }
  }
  return PRODUCTS.filter((p) => !DEACTIVATED_PRODUCTS.includes(p))
}

export async function setActiveCommentProducts(list: string[]): Promise<void> {
  await ensureAdminTables()
  const clean = Array.from(new Set(list.filter((p) => isProduct(p))))
  await pool.query('UPDATE app_state SET active_comment_products = $1 WHERE id = 1', [JSON.stringify(clean)])
}

/** Word band for reply drafts, falling back to the compiled defaults. */
export async function getReplyWordBand(dflt: WordBand): Promise<WordBand> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ lo: number | null; hi: number | null }>(
    'SELECT reply_word_min AS lo, reply_word_max AS hi FROM app_state WHERE id = 1'
  )
  const r = rows[0]
  if (!r || r.lo == null || r.hi == null) return dflt
  return { min: r.lo, max: r.hi }
}

/** Save the band, clamped and ordered. Returns what was stored. */
export async function setReplyWordBand(min: number, max: number): Promise<WordBand> {
  await ensureAdminTables()
  // Clamped: a 1-word reply cannot both answer a comment and name a product,
  // and past ~40 words it stops reading like a phone reply.
  const lo = Math.max(3, Math.min(40, Math.round(min)))
  const hi = Math.max(3, Math.min(40, Math.round(max)))
  const band = { min: Math.min(lo, hi), max: Math.max(lo, hi) }
  await pool.query('UPDATE app_state SET reply_word_min = $1, reply_word_max = $2 WHERE id = 1', [
    band.min,
    band.max,
  ])
  return band
}

// ── Posted-date cluster weights ──────────────────────────────────────────────
// Stored rather than compiled in, because changing them is an operational
// decision the admin makes from the Recluster modal. Both the recluster button
// and every upload read these, so a later upload can't silently re-score the
// pool with different weights than the ones the admin last applied.

/** The saved posted-date weights, or the compiled defaults if none are saved. */
export async function getDateWeights(): Promise<DateWeights> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ v: string | null }>(
    'SELECT date_weights AS v FROM app_state WHERE id = 1'
  )
  const raw = rows[0]?.v
  if (raw) {
    try {
      return normalizeDateWeights(JSON.parse(raw) as Partial<DateWeights>)
    } catch {
      /* unreadable JSON — fall through to the defaults */
    }
  }
  return { ...DEFAULT_DATE_WEIGHTS }
}

/** Saves weights, normalised to sum to 1. Returns what was actually stored. */
export async function setDateWeights(w: Partial<DateWeights>): Promise<DateWeights> {
  await ensureAdminTables()
  const clean = normalizeDateWeights(w)
  await pool.query('UPDATE app_state SET date_weights = $1 WHERE id = 1', [JSON.stringify(clean)])
  return clean
}

// ── Downloadable app asset: the Android APK (single, globally-shared) ─────────
export interface ApkInfo {
  url: string
  filename: string | null
  size: number | null
  version: string | null
  versionCode: number | null
  updated_at: string
}

export async function getApk(): Promise<ApkInfo | null> {
  await ensureAdminTables()
  const { rows } = await pool.query<{
    url: string
    filename: string | null
    size: string | null
    version: string | null
    version_code: number | null
    updated_at: string
  }>(
    `SELECT url, filename, size::text AS size, version, version_code, updated_at::text AS updated_at
     FROM app_asset WHERE key = 'apk'`
  )
  const r = rows[0]
  if (!r) return null
  return {
    url: r.url,
    filename: r.filename,
    size: r.size != null ? Number(r.size) : null,
    version: r.version,
    versionCode: r.version_code != null ? Number(r.version_code) : null,
    updated_at: r.updated_at,
  }
}

// Upsert the current APK. Returns the previous blob url (if any) so the caller
// can delete the superseded blob.
export async function setApk(meta: {
  url: string
  filename?: string | null
  size?: number | null
  version?: string | null
  versionCode?: number | null
}): Promise<{ prevUrl: string | null }> {
  await ensureAdminTables()
  const prev = await pool.query<{ url: string }>(`SELECT url FROM app_asset WHERE key = 'apk'`)
  await pool.query(
    `INSERT INTO app_asset (key, url, filename, size, version, version_code, updated_at)
     VALUES ('apk', $1, $2, $3, $4, $5, now())
     ON CONFLICT (key) DO UPDATE
       SET url = EXCLUDED.url, filename = EXCLUDED.filename, size = EXCLUDED.size,
           version = EXCLUDED.version, version_code = EXCLUDED.version_code, updated_at = now()`,
    [meta.url, meta.filename ?? null, meta.size ?? null, meta.version ?? null, meta.versionCode ?? null]
  )
  const prevUrl = prev.rows[0]?.url ?? null
  return { prevUrl: prevUrl && prevUrl !== meta.url ? prevUrl : null }
}

export interface GuideVideo {
  id: number
  url: string
  filename: string | null
  size: number | null
  title: string
  note: string
  lang: string
  position: number
}

/** Every guide clip, in the order the guide page shows them. */
export async function getGuideVideos(): Promise<GuideVideo[]> {
  await ensureAdminTables()
  const { rows } = await pool.query<GuideVideo>(
    `SELECT id, url, filename, size::int AS size, title, note, lang, position
       FROM guide_video ORDER BY position, id`
  )
  return rows
}

/** Append a clip. New clips go last, so adding one never reorders the guide. */
export async function addGuideVideo(v: {
  url: string
  filename?: string | null
  size?: number | null
  title?: string
  note?: string
  lang?: string
}): Promise<GuideVideo> {
  await ensureAdminTables()
  const { rows } = await pool.query<GuideVideo>(
    `INSERT INTO guide_video (url, filename, size, title, note, lang, position)
     VALUES ($1, $2, $3, $4, $5, $6,
             COALESCE((SELECT max(position) + 1 FROM guide_video), 0))
     RETURNING id, url, filename, size::int AS size, title, note, lang, position`,
    [
      v.url,
      v.filename ?? null,
      v.size ?? null,
      (v.title ?? '').slice(0, 200),
      (v.note ?? '').slice(0, 500),
      (v.lang ?? '').slice(0, 20),
    ]
  )
  return rows[0]
}

/** Edit a clip's text. Only the fields given are touched. */
export async function updateGuideVideo(
  id: number,
  patch: { title?: string; note?: string; lang?: string }
): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    `UPDATE guide_video
        SET title = COALESCE($2, title), note = COALESCE($3, note), lang = COALESCE($4, lang)
      WHERE id = $1`,
    [
      id,
      patch.title === undefined ? null : patch.title.slice(0, 200),
      patch.note === undefined ? null : patch.note.slice(0, 500),
      patch.lang === undefined ? null : patch.lang.slice(0, 20),
    ]
  )
}

/** Remove a clip. Returns its blob URL so the caller can delete the file too. */
export async function deleteGuideVideo(id: number): Promise<string | null> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ url: string }>(
    'DELETE FROM guide_video WHERE id = $1 RETURNING url',
    [id]
  )
  return rows[0]?.url ?? null
}

/**
 * Move a clip one place up or down.
 *
 * Positions are rewritten from the resulting order rather than swapped, so a
 * list that arrived with duplicate or gapped positions (an interrupted write,
 * an old row) comes out clean instead of getting stuck.
 */
export async function moveGuideVideo(id: number, dir: -1 | 1): Promise<void> {
  await ensureAdminTables()
  const all = await getGuideVideos()
  const i = all.findIndex((v) => v.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= all.length) return
  const order = all.map((v) => v.id)
  ;[order[i], order[j]] = [order[j], order[i]]
  await pool.query(
    `UPDATE guide_video AS g SET position = x.pos
       FROM unnest($1::int[]) WITH ORDINALITY AS x(id, pos)
      WHERE g.id = x.id`,
    [order]
  )
}

// Record which app version a user is running (called from the app status ping).
export async function recordAppVersion(
  userId: string,
  versionName: string | null,
  versionCode: number | null
): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    `INSERT INTO user_app (user_id, version_name, version_code, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET version_name = EXCLUDED.version_name, version_code = EXCLUDED.version_code, updated_at = now()`,
    [userId, versionName, versionCode]
  )
}

// Per-user app version (the versionName the app reports) for the admin dashboard.
export async function getUserAppVersions(): Promise<Record<string, { name: string | null; code: number | null }>> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ user_id: string; version_name: string | null; version_code: number | null }>(
    `SELECT user_id, version_name, version_code FROM user_app`
  )
  const out: Record<string, { name: string | null; code: number | null }> = {}
  for (const r of rows) out[r.user_id] = { name: r.version_name, code: r.version_code != null ? Number(r.version_code) : null }
  return out
}

// Remove the APK record. Returns its blob url so the caller can delete the blob.
export async function deleteApk(): Promise<{ url: string | null }> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ url: string }>(
    `DELETE FROM app_asset WHERE key = 'apk' RETURNING url`
  )
  return { url: rows[0]?.url ?? null }
}

// ── Native app tokens (Google-signed-in mobile bubble) ───────────────────────
export async function createAppToken(userId: string): Promise<string> {
  await ensureAdminTables()
  const token = randomBytes(32).toString('hex')
  await pool.query('INSERT INTO app_token (user_id, token) VALUES ($1, $2)', [userId, token])
  return token
}

// Resolve a bearer token to a user id (and bump last_used_at). Null if unknown.
export async function getUserIdByAppToken(token: string): Promise<string | null> {
  if (!token) return null
  await ensureAdminTables()
  const { rows } = await pool.query<{ user_id: string }>(
    'UPDATE app_token SET last_used_at = now() WHERE token = $1 RETURNING user_id',
    [token]
  )
  return rows[0]?.user_id ?? null
}

// Basic identity for the app's "me" endpoint.
export async function getUserNameEmail(userId: string): Promise<{ name: string; email: string } | null> {
  const { rows } = await pool.query<{ name: string | null; email: string }>(
    'SELECT name, email FROM "user" WHERE id = $1',
    [userId]
  )
  const r = rows[0]
  return r ? { name: r.name ?? '', email: r.email } : null
}

// ── AI-generated comments (per product) ──────────────────────────────────────
// The LLM-rewritten click-to-copy comments live here so every serverless
// instance shares one set and we regenerate at most once per refresh window.
// `locked_at` is a short-lived lease so only one request regenerates at a time.
let ensuredComments: Promise<void> | null = null

export function ensureCommentsTable(): Promise<void> {
  if (!ensuredComments) {
    ensuredComments = pool
      .query(`
        -- Comments written for one PRODUCT and one AUDIENCE. Separate from
        -- generated_comments (which is keyed by product alone) so the live table
        -- keeps its primary key and older app builds keep working unchanged.
        CREATE TABLE IF NOT EXISTS category_comments (
          product      TEXT NOT NULL,
          category     TEXT NOT NULL,
          comments     JSONB NOT NULL DEFAULT '[]'::jsonb,
          generated_at TIMESTAMPTZ,
          locked_at    TIMESTAMPTZ,
          PRIMARY KEY (product, category)
        );
        -- The VOICES this set is built from, in the order they were added.
        --
        -- A set is a deliberate mix: generate on one voice, switch, add another.
        -- Without recording it, the nightly regeneration rebuilt the set from
        -- whatever single voice happened to be selected at the time, so every
        -- mix an admin built was flattened overnight and the work was lost.
        -- Empty means "whatever the product's current voice is", which is what
        -- every set did before this existed.
        ALTER TABLE category_comments
          ADD COLUMN IF NOT EXISTS voices JSONB NOT NULL DEFAULT '[]'::jsonb;
        CREATE TABLE IF NOT EXISTS generated_comments (
          product      TEXT PRIMARY KEY,
          comments     JSONB NOT NULL DEFAULT '[]'::jsonb,
          generated_at TIMESTAMPTZ,
          locked_at    TIMESTAMPTZ
        );
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredComments = null
        throw e
      })
  }
  return ensuredComments
}

export async function getCategoryComments(
  product: string,
  category: string
): Promise<{ comments: string[]; generated_at: Date | null; voices: string[] } | null> {
  await ensureCommentsTable()
  const { rows } = await pool.query<{
    comments: string[]
    generated_at: Date | null
    voices: string[]
  }>(
    'SELECT comments, generated_at, voices FROM category_comments WHERE product = $1 AND category = $2',
    [product, category]
  )
  const r = rows[0]
  if (!r) return null
  return {
    comments: Array.isArray(r.comments) ? r.comments : [],
    generated_at: r.generated_at,
    // Only voices we still recognise: a voice removed from the product would
    // otherwise sit in the recipe forever and fail every regeneration.
    voices: (Array.isArray(r.voices) ? r.voices : []).map(String).filter(isCommentVoice),
  }
}

export async function saveCategoryComments(
  product: string,
  category: string,
  comments: string[],
  // The voices the set is now built from. Omitted leaves the recorded mix
  // alone, so a caller that only edits the text cannot erase the recipe.
  voices?: string[]
): Promise<void> {
  await ensureCommentsTable()
  const clean = voices === undefined ? null : voices.filter(isCommentVoice)
  await pool.query(
    `INSERT INTO category_comments (product, category, comments, voices, generated_at)
     VALUES ($1, $2, $3::jsonb, COALESCE($4::jsonb, '[]'::jsonb), now())
     ON CONFLICT (product, category) DO UPDATE SET
       comments = EXCLUDED.comments,
       voices = COALESCE($4::jsonb, category_comments.voices),
       generated_at = now(), locked_at = NULL`,
    [product, category, JSON.stringify(comments), clean === null ? null : JSON.stringify(clean)]
  )
}

/**
 * Add a voice to a set's recorded mix, keeping the order it was added in.
 *
 * Separate from saving the comments because appending a batch does both and
 * they fail independently: a batch that generated but whose voice was not
 * recorded would be rebuilt without that voice the next night.
 */
export async function addCategoryVoice(
  product: string,
  category: string,
  voice: string
): Promise<string[]> {
  if (!isCommentVoice(voice)) return []
  await ensureCommentsTable()
  const { rows } = await pool.query<{ voices: string[] }>(
    `UPDATE category_comments
        SET voices = CASE
              WHEN voices @> $3::jsonb THEN voices
              ELSE voices || $3::jsonb
            END
      WHERE product = $1 AND category = $2
      RETURNING voices`,
    [product, category, JSON.stringify([voice])]
  )
  return (rows[0]?.voices ?? []).map(String).filter(isCommentVoice)
}

/** Replace a set's recorded mix outright (the admin editing the recipe). */
export async function setCategoryVoices(
  product: string,
  category: string,
  voices: string[]
): Promise<string[]> {
  await ensureCommentsTable()
  const clean = Array.from(new Set(voices.filter(isCommentVoice)))
  await pool.query(
    `INSERT INTO category_comments (product, category, voices)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (product, category) DO UPDATE SET voices = EXCLUDED.voices`,
    [product, category, JSON.stringify(clean)]
  )
  return clean
}

/** Lease-based lock, so two requests can't regenerate the same pair at once. */
export async function acquireCategoryLock(
  product: string,
  category: string,
  leaseMs: number
): Promise<boolean> {
  await ensureCommentsTable()
  const { rowCount } = await pool.query(
    `INSERT INTO category_comments (product, category, locked_at)
     VALUES ($1, $2, now())
     ON CONFLICT (product, category) DO UPDATE SET locked_at = now()
     WHERE category_comments.locked_at IS NULL
        OR category_comments.locked_at < now() - ($3::int || ' milliseconds')::interval`,
    [product, category, leaseMs]
  )
  return (rowCount ?? 0) > 0
}

export async function releaseCategoryLock(product: string, category: string): Promise<void> {
  await ensureCommentsTable()
  await pool
    .query('UPDATE category_comments SET locked_at = NULL WHERE product = $1 AND category = $2', [
      product,
      category,
    ])
    .catch(() => {})
}

export interface GeneratedComments {
  comments: string[]
  generated_at: Date | null
}

export async function getGeneratedComments(product: string): Promise<GeneratedComments | null> {
  await ensureCommentsTable()
  const { rows } = await pool.query<{ comments: string[]; generated_at: Date | null }>(
    'SELECT comments, generated_at FROM generated_comments WHERE product = $1',
    [product]
  )
  const r = rows[0]
  if (!r) return null
  return { comments: Array.isArray(r.comments) ? r.comments : [], generated_at: r.generated_at }
}

/**
 * How many comments each product holds, summed across its three audiences.
 *
 * The audience sets are the only comments there are, so this is the product's
 * whole stock. One query for the whole switcher rather than one per product:
 * the picker shows every product, and a count beside each is what makes it
 * obvious which ones have never been generated.
 */
export async function getCommentSetSizes(): Promise<Record<string, number>> {
  await ensureCommentsTable()
  const { rows } = await pool.query<{ product: string; n: number }>(
    `SELECT product, COALESCE(SUM(jsonb_array_length(comments)), 0)::int AS n
       FROM category_comments
      GROUP BY product`
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[r.product] = r.n
  return out
}

// ── Dropping one comment an admin does not want ──────────────────────────────
// BY TEXT, not by position. The list on screen can be a regeneration behind the
// stored one, and deleting index 7 would then remove whatever happens to be
// seventh now — silently, and with nothing to point at afterwards. An exact
// string either matches the line that was on screen or matches nothing.
//
// generated_at is deliberately left alone. It drives the refresh schedule, and
// saveGeneratedComments resets it — so routing a delete through that would make
// removing one line look like a full regeneration and push the next one back.

/** Remove one comment from a product's set. Returns how many were removed. */
export async function deleteGeneratedComment(product: string, text: string): Promise<number> {
  await ensureCommentsTable()
  const { rows } = await pool.query<{ comments: string[] }>(
    'SELECT comments FROM generated_comments WHERE product = $1',
    [product]
  )
  const before = Array.isArray(rows[0]?.comments) ? rows[0].comments : []
  const after = before.filter((c) => String(c) !== text)
  if (after.length === before.length) return 0
  await pool.query('UPDATE generated_comments SET comments = $2::jsonb WHERE product = $1', [
    product,
    JSON.stringify(after),
  ])
  return before.length - after.length
}

/** Remove one comment from one audience's set. Returns how many were removed. */
export async function deleteCategoryComment(
  product: string,
  category: string,
  text: string
): Promise<number> {
  await ensureCommentsTable()
  const { rows } = await pool.query<{ comments: string[] }>(
    'SELECT comments FROM category_comments WHERE product = $1 AND category = $2',
    [product, category]
  )
  const before = Array.isArray(rows[0]?.comments) ? rows[0].comments : []
  const after = before.filter((c) => String(c) !== text)
  if (after.length === before.length) return 0
  await pool.query(
    'UPDATE category_comments SET comments = $3::jsonb WHERE product = $1 AND category = $2',
    [product, category, JSON.stringify(after)]
  )
  return before.length - after.length
}

export async function saveGeneratedComments(product: string, comments: string[]): Promise<void> {
  await ensureCommentsTable()
  await pool.query(
    `INSERT INTO generated_comments (product, comments, generated_at, locked_at)
     VALUES ($1, $2::jsonb, now(), NULL)
     ON CONFLICT (product) DO UPDATE SET
       comments     = EXCLUDED.comments,
       generated_at = now(),
       locked_at    = NULL`,
    [product, JSON.stringify(comments)]
  )
}

/**
 * Try to take the regeneration lease for a product. Returns true only to the
 * ONE caller that wins it; concurrent callers get false and should serve the
 * cached comments instead. A stale lease (older than leaseMs) can be re-taken
 * so a crashed generation never blocks forever.
 */
export async function acquireCommentLock(product: string, leaseMs: number): Promise<boolean> {
  await ensureCommentsTable()
  // Make sure a row exists so the UPDATE below can match it.
  await pool.query(
    `INSERT INTO generated_comments (product) VALUES ($1)
     ON CONFLICT (product) DO NOTHING`,
    [product]
  )
  const { rows } = await pool.query<{ product: string }>(
    `UPDATE generated_comments
        SET locked_at = now()
      WHERE product = $1
        AND (locked_at IS NULL OR locked_at < now() - ($2::text || ' milliseconds')::interval)
      RETURNING product`,
    [product, String(leaseMs)]
  )
  return rows.length > 0
}

export async function releaseCommentLock(product: string): Promise<void> {
  await ensureCommentsTable()
  await pool.query('UPDATE generated_comments SET locked_at = NULL WHERE product = $1', [product])
}

// Per-product freshness info for the admin dashboard.
export async function getCommentGenStatus(): Promise<
  Record<string, { count: number; generated_at: string | null }>
> {
  await ensureCommentsTable()
  const { rows } = await pool.query<{ product: string; count: string; generated_at: Date | null }>(
    `SELECT product, jsonb_array_length(comments) AS count, generated_at
       FROM generated_comments`
  )
  const out: Record<string, { count: number; generated_at: string | null }> = {}
  for (const r of rows) {
    out[r.product] = {
      count: Number(r.count) || 0,
      generated_at: r.generated_at ? new Date(r.generated_at).toISOString() : null,
    }
  }
  return out
}

// ── Promo videos (admin uploads, users download + repost) ────────────────────
let ensuredPromo: Promise<void> | null = null

export function ensurePromoTables(): Promise<void> {
  if (!ensuredPromo) {
    ensuredPromo = pool
      .query(`
        CREATE TABLE IF NOT EXISTS promo_video (
          id         BIGSERIAL PRIMARY KEY,
          url        TEXT NOT NULL,
          filename   TEXT,
          size       BIGINT,
          tags       TEXT NOT NULL DEFAULT '',
          product    TEXT,
          active     BOOLEAN NOT NULL DEFAULT true,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE promo_video ADD COLUMN IF NOT EXISTS product TEXT;

        CREATE TABLE IF NOT EXISTS promo_title (
          id         BIGSERIAL PRIMARY KEY,
          video_id   BIGINT NOT NULL,
          title      TEXT NOT NULL,
          claimed_by TEXT,
          claimed_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS promo_title_video_idx ON promo_title (video_id);

        CREATE TABLE IF NOT EXISTS promo_download (
          id            BIGSERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          video_id      BIGINT NOT NULL,
          downloaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, video_id)
        );

        CREATE TABLE IF NOT EXISTS promo_link (
          id           BIGSERIAL PRIMARY KEY,
          user_id      TEXT NOT NULL,
          video_id     BIGINT,
          title_id     BIGINT,
          platform     TEXT NOT NULL,
          url          TEXT NOT NULL,
          paid         BOOLEAN NOT NULL DEFAULT false,
          submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS promo_link_user_idx ON promo_link (user_id);

        -- The dedicated account a user created to repost promos, per platform.
        -- Collected the first time they open the Repost & earn page.
        CREATE TABLE IF NOT EXISTS promo_account (
          user_id    TEXT NOT NULL,
          platform   TEXT NOT NULL,
          url        TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, platform)
        );
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredPromo = null
        throw e
      })
  }
  return ensuredPromo
}

export interface PromoTitleRow {
  id: number
  title: string
  claimed_by: string | null
}
export interface PromoLinkRow {
  id: number
  video_id: number | null
  title_id: number | null
  platform: string
  url: string
  paid: boolean
  submitted_at: string
}
// What a user sees for one promo video.
export interface PromoVideoUser {
  id: number
  url: string
  filename: string | null
  size: number | null
  product: string | null
  created_at: string
  downloaded: boolean
  myLinks: PromoLinkRow[]
}

// Admin: add a promo video for a product. Titles + tags are generated by the AI
// per product, so the admin only supplies the video + which product it promotes.
export async function createPromoVideo(v: {
  url: string
  filename: string | null
  size: number | null
  product: string
}): Promise<number> {
  await ensurePromoTables()
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO promo_video (url, filename, size, product) VALUES ($1, $2, $3, $4) RETURNING id`,
    [v.url, v.filename, v.size, v.product]
  )
  return rows[0].id
}

export async function deletePromoVideo(id: number): Promise<void> {
  await ensurePromoTables()
  const { rows } = await pool.query<{ url: string }>('SELECT url FROM promo_video WHERE id = $1', [id])
  const url = rows[0]?.url
  if (url) {
    try {
      await del(url)
    } catch {
      /* best effort */
    }
  }
  await pool.query('DELETE FROM promo_title WHERE video_id = $1', [id])
  await pool.query('DELETE FROM promo_video WHERE id = $1', [id])
}

export async function setPromoActive(id: number, active: boolean): Promise<void> {
  await ensurePromoTables()
  await pool.query('UPDATE promo_video SET active = $2 WHERE id = $1', [id, active])
}

export async function setPromoLinkPaid(id: number, paid: boolean): Promise<void> {
  await ensurePromoTables()
  await pool.query('UPDATE promo_link SET paid = $2 WHERE id = $1', [id, paid])
}

// User: active videos + this user's own download / link state.
export async function getPromoVideosForUser(userId: string): Promise<PromoVideoUser[]> {
  await ensurePromoTables()
  const [videos, downloads, links] = await Promise.all([
    pool.query<{ id: number; url: string; filename: string | null; size: string | null; product: string | null; created_at: Date }>(
      `SELECT id, url, filename, size, product, created_at FROM promo_video WHERE active ORDER BY created_at DESC`
    ),
    pool.query<{ video_id: number }>(`SELECT video_id FROM promo_download WHERE user_id = $1`, [userId]),
    pool.query<PromoLinkRow>(
      `SELECT id, video_id, title_id, platform, url, paid,
              to_char(submitted_at, 'YYYY-MM-DD"T"HH24:MI') AS submitted_at
         FROM promo_link WHERE user_id = $1 ORDER BY submitted_at DESC`,
      [userId]
    ),
  ])
  const downloaded = new Set(downloads.rows.map((r) => r.video_id))
  return videos.rows.map((v) => ({
    id: v.id,
    url: v.url,
    filename: v.filename,
    size: v.size != null ? Number(v.size) : null,
    product: v.product,
    created_at: new Date(v.created_at).toISOString(),
    downloaded: downloaded.has(v.id),
    myLinks: links.rows.filter((l) => l.video_id === v.id),
  }))
}

// The user's dedicated repost accounts, keyed by platform (empty = not set up).
export async function getPromoAccounts(userId: string): Promise<Record<string, string>> {
  await ensurePromoTables()
  const { rows } = await pool.query<{ platform: string; url: string }>(
    'SELECT platform, url FROM promo_account WHERE user_id = $1',
    [userId]
  )
  const out: Record<string, string> = {}
  for (const r of rows) out[r.platform] = r.url
  return out
}

// Save/replace the dedicated account links the user entered (skips blanks).
export async function savePromoAccounts(
  userId: string,
  accounts: { platform: string; url: string }[]
): Promise<void> {
  await ensurePromoTables()
  for (const a of accounts) {
    const url = a.url.trim()
    if (!url) continue
    await pool.query(
      `INSERT INTO promo_account (user_id, platform, url) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, platform) DO UPDATE SET url = EXCLUDED.url`,
      [userId, a.platform, url]
    )
  }
}

export async function recordPromoDownload(userId: string, videoId: number): Promise<void> {
  await ensurePromoTables()
  await pool.query(
    `INSERT INTO promo_download (user_id, video_id) VALUES ($1, $2)
     ON CONFLICT (user_id, video_id) DO NOTHING`,
    [userId, videoId]
  )
}

// How many links this user submitted for a platform TODAY (server day, UTC).
export async function countPromoLinksToday(userId: string, platform: string): Promise<number> {
  await ensurePromoTables()
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM promo_link
      WHERE user_id = $1 AND platform = $2 AND submitted_at >= date_trunc('day', now())`,
    [userId, platform]
  )
  return rows[0]?.n ?? 0
}

export async function submitPromoLink(
  userId: string,
  v: { videoId: number | null; titleId: number | null; platform: string; url: string }
): Promise<void> {
  await ensurePromoTables()
  await pool.query(
    `INSERT INTO promo_link (user_id, video_id, title_id, platform, url)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, v.videoId, v.titleId, v.platform, v.url]
  )
}

export async function getUserPromoLinkCount(userId: string): Promise<number> {
  await ensurePromoTables()
  const { rows } = await pool.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM promo_link WHERE user_id = $1',
    [userId]
  )
  return rows[0]?.n ?? 0
}

// Admin view: every video with all its submitted links.
export interface PromoVideoAdmin {
  id: number
  url: string
  filename: string | null
  size: number | null
  product: string | null
  active: boolean
  created_at: string
  links: (PromoLinkRow & { userId: string; userName: string })[]
}

export async function getPromoAdminData(): Promise<PromoVideoAdmin[]> {
  await ensurePromoTables()
  const [videos, links, users] = await Promise.all([
    pool.query<{ id: number; url: string; filename: string | null; size: string | null; product: string | null; active: boolean; created_at: Date }>(
      `SELECT id, url, filename, size, product, active, created_at FROM promo_video ORDER BY created_at DESC`
    ),
    pool.query<PromoLinkRow & { user_id: string }>(
      `SELECT id, user_id, video_id, title_id, platform, url, paid,
              to_char(submitted_at, 'YYYY-MM-DD"T"HH24:MI') AS submitted_at
         FROM promo_link ORDER BY submitted_at DESC`
    ),
    pool.query<{ id: string; name: string | null; email: string }>(
      `SELECT id, name, email FROM "user"`
    ),
  ])
  const nameOf = new Map(users.rows.map((u) => [u.id, u.name || u.email]))
  return videos.rows.map((v) => ({
    id: v.id,
    url: v.url,
    filename: v.filename,
    size: v.size != null ? Number(v.size) : null,
    product: v.product,
    active: v.active,
    created_at: new Date(v.created_at).toISOString(),
    links: links.rows
      .filter((l) => l.video_id === v.id)
      .map((l) => ({ ...l, userId: l.user_id, userName: nameOf.get(l.user_id) ?? l.user_id })),
  }))
}

// ── AI-generated promo captions (titles + extra tags) per product ─────────────
let ensuredPromoGen: Promise<void> | null = null

export function ensurePromoGenTable(): Promise<void> {
  if (!ensuredPromoGen) {
    ensuredPromoGen = pool
      .query(`
        CREATE TABLE IF NOT EXISTS generated_promo (
          product      TEXT PRIMARY KEY,
          titles       JSONB NOT NULL DEFAULT '[]'::jsonb,
          extra_tags   JSONB NOT NULL DEFAULT '[]'::jsonb,
          generated_at TIMESTAMPTZ,
          locked_at    TIMESTAMPTZ
        );
      `)
      .then(() => undefined)
      .catch((e) => {
        ensuredPromoGen = null
        throw e
      })
  }
  return ensuredPromoGen
}

export interface GeneratedPromo {
  titles: string[]
  extraTags: string[]
  generated_at: Date | null
}

export async function getGeneratedPromo(product: string): Promise<GeneratedPromo | null> {
  await ensurePromoGenTable()
  const { rows } = await pool.query<{ titles: string[]; extra_tags: string[]; generated_at: Date | null }>(
    'SELECT titles, extra_tags, generated_at FROM generated_promo WHERE product = $1',
    [product]
  )
  const r = rows[0]
  if (!r) return null
  return {
    titles: Array.isArray(r.titles) ? r.titles : [],
    extraTags: Array.isArray(r.extra_tags) ? r.extra_tags : [],
    generated_at: r.generated_at,
  }
}

export async function saveGeneratedPromo(
  product: string,
  titles: string[],
  extraTags: string[]
): Promise<void> {
  await ensurePromoGenTable()
  await pool.query(
    `INSERT INTO generated_promo (product, titles, extra_tags, generated_at, locked_at)
     VALUES ($1, $2::jsonb, $3::jsonb, now(), NULL)
     ON CONFLICT (product) DO UPDATE SET
       titles = EXCLUDED.titles, extra_tags = EXCLUDED.extra_tags,
       generated_at = now(), locked_at = NULL`,
    [product, JSON.stringify(titles), JSON.stringify(extraTags)]
  )
}

export async function acquirePromoLock(product: string, leaseMs: number): Promise<boolean> {
  await ensurePromoGenTable()
  await pool.query(
    `INSERT INTO generated_promo (product) VALUES ($1) ON CONFLICT (product) DO NOTHING`,
    [product]
  )
  const { rows } = await pool.query<{ product: string }>(
    `UPDATE generated_promo SET locked_at = now()
      WHERE product = $1
        AND (locked_at IS NULL OR locked_at < now() - ($2::text || ' milliseconds')::interval)
      RETURNING product`,
    [product, String(leaseMs)]
  )
  return rows.length > 0
}

export async function releasePromoLock(product: string): Promise<void> {
  await ensurePromoGenTable()
  await pool.query('UPDATE generated_promo SET locked_at = NULL WHERE product = $1', [product])
}

// ── A user's own pending (unpaid / unapproved) earnings, per task ─────────────
export interface PendingTask {
  count: number
  birr: number
}
export interface PendingPayments {
  comments: PendingTask
  video: PendingTask
  promo: PendingTask
  /** Mailboxes an admin has validated. Payable, and part of `total`. */
  accounts: PendingTask
  /**
   * Mailboxes submitted but NOT yet validated.
   *
   * Deliberately outside `total`: the address is worth nothing until someone
   * has confirmed it exists, and approveUserPay snapshots `total`, so counting
   * it there would let a payout approve work nobody had checked. The user is
   * shown it as unapproved, which is what it is.
   */
  accountsAwaiting: PendingTask
  total: number
  approved: boolean // admin has approved (some of) the current pending pay
  approvedBirr: number // birr already approved (snapshot at approval)
  unapprovedBirr: number // birr earned since approval — not yet approved
}

export async function getUserPendingPayments(userId: string): Promise<PendingPayments> {
  await Promise.all([ensureAdminTables(), ensurePromoTables()])
  const resetAt = await getResetAt()
  const [commentedRes, videoRes, promoRes, accountRes, statusRes] = await Promise.all([
    // Comment pay: counts comments after the effective reset AND after the last
    // time the admin marked this user's comment pay as paid.
    pool.query<{ n: number }>(
      `SELECT COALESCE(SUM(cs.count), 0)::int AS n
         FROM commented_submission cs
         LEFT JOIN user_reset ur ON ur.user_id = cs.user_id
         LEFT JOIN comment_pay_marker cpm ON cpm.user_id = cs.user_id
        WHERE cs.user_id = $1
          AND cs.submitted_at >= GREATEST(
                $2::timestamptz,
                COALESCE(ur.reset_at, $2::timestamptz),
                COALESCE(cpm.paid_at, $2::timestamptz))`,
      [userId, resetAt]
    ),
    // Video pay is owed only for APPROVED submissions not yet marked paid.
    pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM video_submission WHERE user_id = $1 AND paid = false AND status = 'approved'`,
      [userId]
    ),
    pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM promo_link WHERE user_id = $1 AND paid = false`,
      [userId]
    ),
    // Two counts from one table: validated-and-unpaid (owed) and awaiting
    // validation (shown, not owed).
    pool.query<{ ok: number; waiting: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'approved' AND paid = false)::int AS ok,
         COUNT(*) FILTER (WHERE status = 'pending')::int                  AS waiting
       FROM account_submission WHERE user_id = $1`,
      [userId]
    ),
    pool.query<{ approved_at: Date | null; approved_amount: string | null }>(
      `SELECT approved_at, approved_amount FROM user_pay_status WHERE user_id = $1`,
      [userId]
    ),
  ])
  const commentsCount = commentedRes.rows[0]?.n ?? 0
  const videoCount = videoRes.rows[0]?.n ?? 0
  const promoCount = promoRes.rows[0]?.n ?? 0
  const accountCount = accountRes.rows[0]?.ok ?? 0
  const awaitingCount = accountRes.rows[0]?.waiting ?? 0
  const comments: PendingTask = { count: commentsCount, birr: commentsCount * COMMENT_PAY_RATE }
  const video: PendingTask = { count: videoCount, birr: videoCount * VIDEO_PAYMENT_BIRR }
  const promo: PendingTask = { count: promoCount, birr: promoCount * PROMO_PAY_BIRR }
  const accounts: PendingTask = { count: accountCount, birr: accountCount * ACCOUNT_PAY_BIRR }
  const accountsAwaiting: PendingTask = {
    count: awaitingCount,
    birr: awaitingCount * ACCOUNT_PAY_BIRR,
  }
  // `accountsAwaiting` is NOT in the total — see the interface.
  const total = comments.birr + video.birr + promo.birr + accounts.birr

  // The approved amount is frozen when the admin approves; anything earned after
  // that is unapproved. total only grows while approved (a paid-mark clears it).
  const st = statusRes.rows[0]
  const approved = !!st?.approved_at
  const approvedSnapshot = st?.approved_amount != null ? Number(st.approved_amount) : 0
  const approvedBirr = approved ? Math.min(approvedSnapshot, total) : 0
  const unapprovedBirr = Math.max(0, total - approvedBirr)

  return {
    comments,
    video,
    promo,
    accounts,
    accountsAwaiting,
    total,
    approved,
    // Everything awaiting validation is unapproved by definition, so it joins
    // the number the user is shown under that heading.
    approvedBirr,
    unapprovedBirr: unapprovedBirr + accountsAwaiting.birr,
  }
}

// ── The mailbox task ─────────────────────────────────────────────────────────

export interface AccountSubmission {
  id: number
  userId: string
  email: string
  status: 'pending' | 'approved' | 'rejected'
  rejectReason: string | null
  paid: boolean
  submittedAt: string
  reviewedAt: string | null
}

/** One submission plus who made it, for the admin queue. */
export interface AccountSubmissionRow extends AccountSubmission {
  userName: string
  userEmail: string
}

const accountRow = (r: Record<string, unknown>): AccountSubmission => ({
  id: Number(r.id),
  userId: String(r.user_id),
  email: String(r.email),
  status: String(r.status) as AccountSubmission['status'],
  rejectReason: r.reject_reason == null ? null : String(r.reject_reason),
  paid: r.paid === true,
  submittedAt: new Date(r.submitted_at as string).toISOString(),
  reviewedAt: r.reviewed_at ? new Date(r.reviewed_at as string).toISOString() : null,
})

/**
 * Record a mailbox a worker says they created.
 *
 * Returns why it was refused rather than throwing, because every refusal here
 * is something the worker needs told in words: the address is already claimed,
 * or it is not on the company domain.
 */
export async function submitAccountEmail(
  userId: string,
  email: string
): Promise<{ ok: boolean; error?: string; submission?: AccountSubmission }> {
  await ensureAdminTables()
  const clean = String(email ?? '').trim().toLowerCase()
  if (!clean) return { ok: false, error: 'Enter the email address you created.' }
  try {
    const { rows } = await pool.query(
      `INSERT INTO account_submission (user_id, email) VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING id, user_id, email, status, reject_reason, paid, submitted_at, reviewed_at`,
      [userId, clean]
    )
    if (rows.length === 0) {
      return { ok: false, error: 'That address has already been submitted.' }
    }
    return { ok: true, submission: accountRow(rows[0]) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** Everything one user has submitted, newest first. */
export async function getUserAccountSubmissions(userId: string): Promise<AccountSubmission[]> {
  await ensureAdminTables()
  const { rows } = await pool.query(
    `SELECT id, user_id, email, status, reject_reason, paid, submitted_at, reviewed_at
       FROM account_submission WHERE user_id = $1 ORDER BY submitted_at DESC`,
    [userId]
  )
  return rows.map(accountRow)
}

/** The admin queue: submissions with the worker who made each one. */
export async function getAccountSubmissions(opts: {
  status?: string
  q?: string
  limit?: number
}): Promise<AccountSubmissionRow[]> {
  await ensureAdminTables()
  const where: string[] = []
  const args: unknown[] = []
  if (opts.status && opts.status !== 'all') {
    args.push(opts.status)
    where.push(`a.status = $${args.length}`)
  }
  if (opts.q && opts.q.trim()) {
    args.push(`%${opts.q.trim().toLowerCase()}%`)
    where.push(
      `(lower(a.email) LIKE $${args.length} OR lower(u.name) LIKE $${args.length}` +
        ` OR lower(u.email) LIKE $${args.length})`
    )
  }
  args.push(Math.min(1000, Math.max(1, opts.limit ?? 500)))
  const { rows } = await pool.query(
    `SELECT a.id, a.user_id, a.email, a.status, a.reject_reason, a.paid,
            a.submitted_at, a.reviewed_at,
            COALESCE(u.name, '')  AS user_name,
            COALESCE(u.email, '') AS user_email
       FROM account_submission a
       LEFT JOIN "user" u ON u.id = a.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (a.status = 'pending') DESC, a.submitted_at DESC
      LIMIT $${args.length}`,
    args
  )
  return rows.map((r) => ({
    ...accountRow(r),
    userName: String(r.user_name ?? ''),
    userEmail: String(r.user_email ?? ''),
  }))
}

/**
 * Approve or reject one submission.
 *
 * Only a PENDING submission may be reviewed. Re-reviewing an approved one would
 * either pay twice or claw back pay the worker has already been told they have,
 * and neither belongs behind a single button.
 */
export async function reviewAccountSubmission(
  id: number,
  adminId: string,
  approve: boolean,
  reason: string
): Promise<{ ok: boolean; error?: string }> {
  await ensureAdminTables()
  const { rowCount } = await pool.query(
    `UPDATE account_submission
        SET status = $2, reject_reason = $3, reviewed_at = now(), reviewed_by = $4
      WHERE id = $1 AND status = 'pending'`,
    [id, approve ? 'approved' : 'rejected', approve ? null : reason.trim() || null, adminId]
  )
  if (!rowCount) return { ok: false, error: 'That submission has already been reviewed.' }
  return { ok: true }
}

/** How many mailboxes are waiting for someone to check them. */
export async function countPendingAccountSubmissions(): Promise<number> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM account_submission WHERE status = 'pending'`
  )
  return rows[0]?.n ?? 0
}

/** The domain workers must create their mailbox on. Admin-settable. */
const ACCOUNT_DOMAIN_KEY = 'account_task_domain'

export async function getAccountTaskDomain(): Promise<string> {
  const saved = await getAppState(ACCOUNT_DOMAIN_KEY).catch(() => null)
  return (saved ?? '').trim() || ACCOUNT_TASK_DEFAULT_DOMAIN
}

export async function setAccountTaskDomain(domain: string): Promise<string> {
  const clean = String(domain ?? '').trim().toLowerCase().replace(/^@/, '')
  await setAppState(ACCOUNT_DOMAIN_KEY, clean)
  return clean
}

/** The password workers set on the mailbox. Blank = do not tell them one. */
const ACCOUNT_PASSWORD_KEY = 'account_task_password'

export async function getAccountTaskPassword(): Promise<string> {
  const saved = await getAppState(ACCOUNT_PASSWORD_KEY).catch(() => null)
  return (saved ?? '').trim() || ACCOUNT_TASK_DEFAULT_PASSWORD
}

export async function setAccountTaskPassword(password: string): Promise<string> {
  // Trimmed, never lowercased: a password is not a domain.
  const clean = String(password ?? '').trim()
  await setAppState(ACCOUNT_PASSWORD_KEY, clean)
  return clean
}

/** Whether the task is open at all. Off by default: a task with no domain set
 *  cannot be done, and one nobody is ready to review should not be advertised. */
const ACCOUNT_OPEN_KEY = 'account_task_open'

export async function getAccountTaskOpen(): Promise<boolean> {
  const raw = await getAppState(ACCOUNT_OPEN_KEY).catch(() => null)
  return raw === '1'
}

export async function setAccountTaskOpen(open: boolean): Promise<boolean> {
  await setAppState(ACCOUNT_OPEN_KEY, open ? '1' : '0')
  return open
}

// ── Which platforms each product's comments may be served on ─────────────────
//
// A product can be right for one site and wrong for another: what reads as
// natural under a TikTok video is not what an Instagram audience is there for,
// and a product with no Instagram landing page should not be advertised to
// Instagram traffic at all.
//
// Stored as { product: platform[] }. A product that is ABSENT is allowed
// everywhere — that is the default every product starts from, and it keeps this
// setting opt-in: nothing changes until an admin narrows something. An EMPTY
// array is a deliberate "nowhere", which is different, and is honoured.
const PRODUCT_PLATFORMS_KEY = 'comment_product_platforms'

export async function getProductPlatforms(): Promise<Record<string, string[]>> {
  const raw = await getAppState(PRODUCT_PLATFORMS_KEY).catch(() => null)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string[]> = {}
    for (const [product, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isProduct(product) || !Array.isArray(list)) continue
      out[product] = list
        .map((x) => String(x))
        .filter((p): p is ClickPlatform => (CLICK_PLATFORMS as readonly string[]).includes(p))
    }
    return out
  } catch {
    return {}
  }
}

export async function setProductPlatforms(map: Record<string, string[]>): Promise<
  Record<string, string[]>
> {
  const clean: Record<string, string[]> = {}
  for (const [product, list] of Object.entries(map ?? {})) {
    if (!isProduct(product) || !Array.isArray(list)) continue
    const platforms = Array.from(
      new Set(
        list
          .map((x) => String(x))
          .filter((p) => (CLICK_PLATFORMS as readonly string[]).includes(p))
      )
    )
    // Every platform ticked is the same as no restriction. Stored as absent so
    // the default and the "all of them" case cannot drift apart, and so adding
    // a new platform later does not silently exclude it from every product.
    if (platforms.length === CLICK_PLATFORMS.length) continue
    clean[product] = platforms
  }
  await setAppState(PRODUCT_PLATFORMS_KEY, JSON.stringify(clean))
  return getProductPlatforms()
}

/**
 * The active products allowed on ONE platform, in their configured order.
 *
 * The order matters: serveCommentForUrl picks fairly among whatever this
 * returns, so silently reordering would change which product leads a video.
 */
export async function activeProductsForPlatform(platform: string): Promise<string[]> {
  const [active, byProduct] = await Promise.all([
    getActiveCommentProducts().catch(() => [] as string[]),
    getProductPlatforms().catch(() => ({}) as Record<string, string[]>),
  ])
  const p = String(platform ?? '')
  return active.filter((product) => {
    const allowed = byProduct[product]
    // Absent = everywhere. Present = exactly these, empty included.
    return allowed === undefined || allowed.includes(p)
  })
}

// Admin approves a user's pending pay (does NOT reset counters). The user then
// sees "(Approved)" instead of "(Unapproved)".
export async function approveUserPay(userId: string): Promise<void> {
  await ensureAdminTables()
  // Snapshot the total being approved; earnings submitted later stay unapproved.
  const pending = await getUserPendingPayments(userId)
  await pool.query(
    `INSERT INTO user_pay_status (user_id, approved_at, approved_amount) VALUES ($1, now(), $2)
     ON CONFLICT (user_id) DO UPDATE SET approved_at = now(), approved_amount = $2`,
    [userId, pending.total]
  )
}

// Inverse of approveUserPay (used by undo).
export async function unapproveUserPay(userId: string): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    'UPDATE user_pay_status SET approved_at = NULL, approved_amount = NULL WHERE user_id = $1',
    [userId]
  )
}

// Permanently delete a user and all of their data (admin action). Best-effort
// deletes the user's uploaded blobs (screenshots + videos) too. Broadcast admin
// messages are kept; only messages targeted at this user are removed.
export async function deleteUser(userId: string): Promise<void> {
  await Promise.all([ensureAdminTables(), ensurePromoTables()])

  // Collect the user's uploaded blob URLs before removing the rows.
  let blobUrls: string[] = []
  try {
    const [shots, vids] = await Promise.all([
      pool.query<{ blob_url: string }>('SELECT blob_url FROM comment_screenshot WHERE user_id = $1', [userId]),
      pool.query<{ url: string }>('SELECT url FROM video_submission WHERE user_id = $1', [userId]),
    ])
    blobUrls = [...shots.rows.map((r) => r.blob_url), ...vids.rows.map((r) => r.url)].filter(Boolean)
  } catch {
    /* ignore — blob cleanup is best-effort */
  }

  const userTables = [
    'clicked_link', 'user_profile', 'user_login_day', 'user_reset', 'user_product',
    'video_access', 'video_submission', 'message_read', 'message_reply',
    'commented_submission', 'comment_screenshot', 'comment_pay_marker',
    'user_pay_status', 'app_token', 'promo_download', 'promo_link', 'promo_account',
  ]
  for (const t of userTables) {
    await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]).catch(() => {})
  }
  // Messages targeted at this user (keep broadcasts, target_user_id IS NULL).
  await pool.query('DELETE FROM admin_message WHERE target_user_id = $1', [userId]).catch(() => {})
  // Better Auth tables — remove sessions/accounts before the user row.
  await pool.query('DELETE FROM session WHERE "userId" = $1', [userId]).catch(() => {})
  await pool.query('DELETE FROM account WHERE "userId" = $1', [userId]).catch(() => {})
  await pool.query('DELETE FROM "user" WHERE id = $1', [userId])

  // Best-effort: delete the user's uploaded blobs so they don't linger.
  for (const url of blobUrls) {
    await del(url).catch(() => {})
  }
}

// Everything needed to reverse a markUserPaid.
export interface MarkPaidUndo {
  videoIds: number[]
  promoIds: number[]
  /** The "you have been paid" message sent with this payment, so undo can
   *  withdraw it — telling someone they were paid and then silently reversing
   *  it would be worse than never telling them. */
  messageId?: number
  prevMarkerPaidAt: string | null
  prevStatus: {
    approved_at: string | null
    approved_amount: number | null
    last_paid_amount: number | null
    last_paid_at: string | null
    paid_ack: boolean
  } | null
}

// Admin marks a user paid: reset all pending counters and record the paid
// amount so the user sees it once on next login. Returns the amount paid plus
// an undo descriptor capturing exactly what changed.
export async function markUserPaid(userId: string): Promise<{ amount: number; undo: MarkPaidUndo }> {
  await Promise.all([ensureAdminTables(), ensurePromoTables()])
  const pending = await getUserPendingPayments(userId) // amount BEFORE resetting
  const amount = pending.total

  // Capture prior state so undo can restore it exactly.
  const mk = await pool.query<{ paid_at: Date }>(
    'SELECT paid_at FROM comment_pay_marker WHERE user_id = $1',
    [userId]
  )
  const prevMarkerPaidAt = mk.rows[0]?.paid_at ? new Date(mk.rows[0].paid_at).toISOString() : null
  const st = await pool.query<{
    approved_at: Date | null
    approved_amount: string | null
    last_paid_amount: string | null
    last_paid_at: Date | null
    paid_ack: boolean
  }>('SELECT approved_at, approved_amount, last_paid_amount, last_paid_at, paid_ack FROM user_pay_status WHERE user_id = $1', [userId])
  const s = st.rows[0]
  const prevStatus = s
    ? {
        approved_at: s.approved_at ? new Date(s.approved_at).toISOString() : null,
        approved_amount: s.approved_amount != null ? Number(s.approved_amount) : null,
        last_paid_amount: s.last_paid_amount != null ? Number(s.last_paid_amount) : null,
        last_paid_at: s.last_paid_at ? new Date(s.last_paid_at).toISOString() : null,
        paid_ack: s.paid_ack,
      }
    : null

  const v = await pool.query<{ id: number }>(
    'UPDATE video_submission SET paid = true WHERE user_id = $1 AND paid = false RETURNING id',
    [userId]
  )
  const p = await pool.query<{ id: number }>(
    'UPDATE promo_link SET paid = true WHERE user_id = $1 AND paid = false RETURNING id',
    [userId]
  )
  await pool.query(
    `INSERT INTO comment_pay_marker (user_id, paid_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET paid_at = now()`,
    [userId]
  )
  await pool.query(
    `INSERT INTO user_pay_status (user_id, last_paid_amount, last_paid_at, paid_ack, approved_at, approved_amount)
     VALUES ($1, $2, now(), false, NULL, NULL)
     ON CONFLICT (user_id) DO UPDATE SET
       last_paid_amount = $2, last_paid_at = now(), paid_ack = false, approved_at = NULL, approved_amount = NULL`,
    [userId, amount]
  )
  return {
    amount,
    undo: {
      videoIds: v.rows.map((r) => r.id),
      promoIds: p.rows.map((r) => r.id),
      prevMarkerPaidAt,
      prevStatus,
    },
  }
}

// Reverse a markUserPaid using its undo descriptor.
export async function undoMarkPaid(userId: string, u: MarkPaidUndo): Promise<void> {
  await Promise.all([ensureAdminTables(), ensurePromoTables()])
  if (u.videoIds.length) {
    await pool.query('UPDATE video_submission SET paid = false WHERE id = ANY($1::bigint[])', [u.videoIds])
  }
  if (u.promoIds.length) {
    await pool.query('UPDATE promo_link SET paid = false WHERE id = ANY($1::bigint[])', [u.promoIds])
  }
  if (u.prevMarkerPaidAt) {
    await pool.query(
      `INSERT INTO comment_pay_marker (user_id, paid_at) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET paid_at = $2`,
      [userId, u.prevMarkerPaidAt]
    )
  } else {
    await pool.query('DELETE FROM comment_pay_marker WHERE user_id = $1', [userId])
  }
  if (u.prevStatus) {
    await pool.query(
      `INSERT INTO user_pay_status (user_id, approved_at, approved_amount, last_paid_amount, last_paid_at, paid_ack)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         approved_at = $2, approved_amount = $3, last_paid_amount = $4, last_paid_at = $5, paid_ack = $6`,
      [userId, u.prevStatus.approved_at, u.prevStatus.approved_amount, u.prevStatus.last_paid_amount, u.prevStatus.last_paid_at, u.prevStatus.paid_ack]
    )
  } else {
    await pool.query('DELETE FROM user_pay_status WHERE user_id = $1', [userId])
  }
}

// Returns the amount the user was just paid, exactly once (the first call after
// a payout), then marks it acknowledged so it isn't shown again.
export async function consumePayNotice(userId: string): Promise<number | null> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ last_paid_amount: string | null }>(
    `UPDATE user_pay_status SET paid_ack = true
      WHERE user_id = $1 AND paid_ack = false AND last_paid_amount IS NOT NULL
      RETURNING last_paid_amount`,
    [userId]
  )
  const amt = rows[0]?.last_paid_amount
  return amt != null ? Number(amt) : null
}

// Per-user pending pay for the admin dashboard, in one batched pass.
export async function getAllPendingPay(): Promise<Record<string, PendingPayments>> {
  await Promise.all([ensureAdminTables(), ensurePromoTables()])
  const resetAt = await getResetAt()
  const [commented, video, promo, accounts, status] = await Promise.all([
    pool.query<{ user_id: string; n: number }>(
      `SELECT cs.user_id, COALESCE(SUM(cs.count), 0)::int AS n
         FROM commented_submission cs
         LEFT JOIN user_reset ur ON ur.user_id = cs.user_id
         LEFT JOIN comment_pay_marker cpm ON cpm.user_id = cs.user_id
        WHERE cs.submitted_at >= GREATEST(
                $1::timestamptz,
                COALESCE(ur.reset_at, $1::timestamptz),
                COALESCE(cpm.paid_at, $1::timestamptz))
        GROUP BY cs.user_id`,
      [resetAt]
    ),
    pool.query<{ user_id: string; n: number }>(
      `SELECT user_id, COUNT(*)::int AS n FROM video_submission WHERE paid = false AND status = 'approved' GROUP BY user_id`
    ),
    pool.query<{ user_id: string; n: number }>(
      `SELECT user_id, COUNT(*)::int AS n FROM promo_link WHERE paid = false GROUP BY user_id`
    ),
    pool.query<{ user_id: string; ok: number; waiting: number }>(
      `SELECT user_id,
              COUNT(*) FILTER (WHERE status = 'approved' AND paid = false)::int AS ok,
              COUNT(*) FILTER (WHERE status = 'pending')::int                  AS waiting
         FROM account_submission GROUP BY user_id`
    ),
    pool.query<{ user_id: string; approved_at: Date | null; approved_amount: string | null }>(
      `SELECT user_id, approved_at, approved_amount FROM user_pay_status`
    ),
  ])
  const out: Record<string, PendingPayments> = {}
  const ensure = (uid: string): PendingPayments =>
    (out[uid] ??= {
      comments: { count: 0, birr: 0 },
      video: { count: 0, birr: 0 },
      promo: { count: 0, birr: 0 },
      accounts: { count: 0, birr: 0 },
      accountsAwaiting: { count: 0, birr: 0 },
      total: 0,
      approved: false,
      approvedBirr: 0,
      unapprovedBirr: 0,
    })
  for (const r of commented.rows) ensure(r.user_id).comments = { count: r.n, birr: r.n * COMMENT_PAY_RATE }
  for (const r of video.rows) ensure(r.user_id).video = { count: r.n, birr: r.n * VIDEO_PAYMENT_BIRR }
  for (const r of promo.rows) ensure(r.user_id).promo = { count: r.n, birr: r.n * PROMO_PAY_BIRR }
  for (const r of accounts.rows) {
    const p = ensure(r.user_id)
    p.accounts = { count: r.ok, birr: r.ok * ACCOUNT_PAY_BIRR }
    p.accountsAwaiting = { count: r.waiting, birr: r.waiting * ACCOUNT_PAY_BIRR }
  }
  const snapshots: Record<string, number | null> = {}
  for (const r of status.rows) {
    if (r.approved_at) ensure(r.user_id).approved = true
    snapshots[r.user_id] = r.approved_amount != null ? Number(r.approved_amount) : null
  }
  for (const uid of Object.keys(out)) {
    const p = out[uid]
    // Same rule as getUserPendingPayments: awaiting-validation mailboxes are
    // shown as unapproved and are NOT payable.
    p.total = p.comments.birr + p.video.birr + p.promo.birr + p.accounts.birr
    p.approvedBirr = p.approved ? Math.min(snapshots[uid] ?? 0, p.total) : 0
    p.unapprovedBirr = Math.max(0, p.total - p.approvedBirr) + p.accountsAwaiting.birr
  }
  return out
}

// ── Promo download daily limit ───────────────────────────────────────────────
// How many videos the user has downloaded today, plus when the quota resets.
export async function getPromoDownloadInfo(
  userId: string
): Promise<{ usedToday: boolean; nextResetMs: number }> {
  await ensurePromoTables()
  const { rows } = await pool.query<{ n: number; next_ms: string }>(
    `SELECT
       (SELECT COUNT(*) FROM promo_download
          WHERE user_id = $1 AND downloaded_at >= date_trunc('day', now()))::int AS n,
       (extract(epoch from (date_trunc('day', now()) + interval '1 day')) * 1000)::bigint::text AS next_ms`,
    [userId]
  )
  return {
    usedToday: (rows[0]?.n ?? 0) >= PROMO_DOWNLOAD_DAILY_LIMIT,
    nextResetMs: Number(rows[0]?.next_ms ?? 0),
  }
}

// True if the user has already downloaded this specific video (re-downloads are
// always allowed and don't consume the daily quota).
export async function hasDownloadedVideo(userId: string, videoId: number): Promise<boolean> {
  await ensurePromoTables()
  const { rows } = await pool.query(
    'SELECT 1 FROM promo_download WHERE user_id = $1 AND video_id = $2',
    [userId, videoId]
  )
  return rows.length > 0
}

export async function countPromoDownloadsToday(userId: string): Promise<number> {
  await ensurePromoTables()
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM promo_download
      WHERE user_id = $1 AND downloaded_at >= date_trunc('day', now())`,
    [userId]
  )
  return rows[0]?.n ?? 0
}

// Admin: all stored promo captions, keyed by product (for display).
export async function getAllGeneratedPromo(): Promise<
  Record<string, { titles: string[]; extraTags: string[]; generatedAt: string | null }>
> {
  await ensurePromoGenTable()
  const { rows } = await pool.query<{
    product: string
    titles: string[]
    extra_tags: string[]
    generated_at: Date | null
  }>('SELECT product, titles, extra_tags, generated_at FROM generated_promo')
  const out: Record<string, { titles: string[]; extraTags: string[]; generatedAt: string | null }> = {}
  for (const r of rows) {
    out[r.product] = {
      titles: Array.isArray(r.titles) ? r.titles : [],
      extraTags: Array.isArray(r.extra_tags) ? r.extra_tags : [],
      generatedAt: r.generated_at ? new Date(r.generated_at).toISOString() : null,
    }
  }
  return out
}

// The reset: move the "since last reset" window to now. Click history is NOT
// deleted (it's needed to keep already-opened links hidden) — the metrics just
// count from this new point, so all totals show as 0 again.
// Delete a set of screenshots (Blob files + DB rows). Blob deletion is
// best-effort so a reset never fails just because a file couldn't be removed.
async function deleteScreenshots(where: string, params: unknown[]): Promise<void> {
  const { rows } = await pool.query<{ blob_url: string }>(
    `SELECT blob_url FROM comment_screenshot ${where}`,
    params
  )
  const urls = rows.map((r) => r.blob_url).filter(Boolean)
  if (urls.length) {
    try {
      await del(urls)
    } catch {
      /* ignore blob-deletion errors */
    }
  }
  await pool.query(`DELETE FROM comment_screenshot ${where}`, params)
}

// Returns the previous global reset_at (ISO) so an undo can restore it. Deleted
// screenshots are NOT restorable.
export async function resetAllData(): Promise<string> {
  await ensureAdminTables()
  const prev = await pool.query<{ reset_at: Date }>('SELECT reset_at FROM app_state WHERE id = 1')
  const prevIso = prev.rows[0]?.reset_at ? new Date(prev.rows[0].reset_at).toISOString() : new Date(0).toISOString()
  await pool.query('UPDATE app_state SET reset_at = now() WHERE id = 1')
  // Reset wipes every user's uploaded screenshots from the backend.
  await deleteScreenshots('', [])
  return prevIso
}

export async function restoreGlobalReset(prevIso: string): Promise<void> {
  await ensureAdminTables()
  await pool.query('UPDATE app_state SET reset_at = $1 WHERE id = 1', [prevIso])
}

// Reset a single user: their "since reset" window moves to now, independent of
// the global reset. Effective window = the later of the global and per-user reset.
// Also deletes that user's uploaded screenshots (Blob files + DB rows).
// Returns the previous per-user reset_at (ISO) or null if none, for undo.
export async function resetUserData(userId: string): Promise<string | null> {
  await ensureAdminTables()
  const prev = await pool.query<{ reset_at: Date }>(
    'SELECT reset_at FROM user_reset WHERE user_id = $1',
    [userId]
  )
  const prevIso = prev.rows[0]?.reset_at ? new Date(prev.rows[0].reset_at).toISOString() : null
  await pool.query(
    `INSERT INTO user_reset (user_id, reset_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET reset_at = now()`,
    [userId]
  )
  await deleteScreenshots('WHERE user_id = $1', [userId])
  return prevIso
}

export async function restoreUserReset(userId: string, prevIso: string | null): Promise<void> {
  await ensureAdminTables()
  if (prevIso) {
    await pool.query(
      `INSERT INTO user_reset (user_id, reset_at) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET reset_at = $2`,
      [userId, prevIso]
    )
  } else {
    await pool.query('DELETE FROM user_reset WHERE user_id = $1', [userId])
  }
}

export async function recordLoginDay(userId: string): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    `INSERT INTO user_login_day (user_id, day) VALUES ($1, current_date)
     ON CONFLICT (user_id, day) DO NOTHING`,
    [userId]
  )
}

// True if the user has any login-day record (call BEFORE recordLoginDay to tell
// whether this is their very first login).
export async function hasAnyLoginDay(userId: string): Promise<boolean> {
  await ensureAdminTables()
  const { rows } = await pool.query('SELECT 1 FROM user_login_day WHERE user_id = $1 LIMIT 1', [userId])
  return rows.length > 0
}

// The product a user is assigned to advertise (null if unassigned).
export async function getUserProduct(userId: string): Promise<string | null> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ product: string }>(
    'SELECT product FROM user_product WHERE user_id = $1',
    [userId]
  )
  return rows[0]?.product ?? null
}

export async function setUserProduct(userId: string, product: string): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    `INSERT INTO user_product (user_id, product, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET product = EXCLUDED.product, updated_at = now()`,
    [userId, product]
  )
}

// Clear a user's product assignment (used when undoing the first assignment).
export async function clearUserProduct(userId: string): Promise<void> {
  await ensureAdminTables()
  await pool.query('DELETE FROM user_product WHERE user_id = $1', [userId])
}

// ── Video task (request access → admin approval → upload → download) ─────────

export type VideoStatus = 'pending' | 'approved' | 'rejected'

export interface VideoSubmission {
  id: number
  url: string
  filename: string | null
  size: number
  paid: boolean
  status: VideoStatus
  reject_reason: string | null
  uploaded_at: string
}

export async function getVideoAccess(userId: string): Promise<VideoStatus | null> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM video_access WHERE user_id = $1',
    [userId]
  )
  return (rows[0]?.status as VideoStatus) ?? null
}

// User asks for permission. Never downgrades an already-approved user.
export async function requestVideoAccess(userId: string): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    `INSERT INTO video_access (user_id, status) VALUES ($1, 'pending')
     ON CONFLICT (user_id) DO UPDATE SET status = 'pending', requested_at = now(), decided_at = NULL
     WHERE video_access.status <> 'approved'`,
    [userId]
  )
}

// Admin approves/rejects.
export async function setVideoAccess(userId: string, status: VideoStatus): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    `INSERT INTO video_access (user_id, status, decided_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET status = $2, decided_at = now()`,
    [userId, status]
  )
}

export async function addVideoSubmission(
  userId: string,
  url: string,
  filename: string | null,
  size: number
): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    'INSERT INTO video_submission (user_id, url, filename, size) VALUES ($1, $2, $3, $4)',
    [userId, url, filename, size]
  )
}

export async function getVideoSubmissions(userId: string): Promise<VideoSubmission[]> {
  await ensureAdminTables()
  const { rows } = await pool.query<{
    id: string
    url: string
    filename: string | null
    size: string | null
    paid: boolean
    status: string
    reject_reason: string | null
    uploaded_at: string
  }>(
    `SELECT id, url, filename, size, paid, status, reject_reason, uploaded_at::text AS uploaded_at
     FROM video_submission WHERE user_id = $1 ORDER BY uploaded_at DESC`,
    [userId]
  )
  return rows.map((r) => ({
    id: Number(r.id),
    url: r.url,
    filename: r.filename,
    size: Number(r.size ?? 0),
    paid: r.paid,
    status: (r.status as VideoStatus) ?? 'pending',
    reject_reason: r.reject_reason,
    uploaded_at: r.uploaded_at,
  }))
}

export async function setVideoPaid(id: number, paid: boolean): Promise<void> {
  await ensureAdminTables()
  await pool.query('UPDATE video_submission SET paid = $2 WHERE id = $1', [id, paid])
}

// Admin accept/reject a single submission. On reject with a reason, notify the
// user via an admin message. Returns the submission's owner + filename.
export async function setVideoSubmissionStatus(
  id: number,
  status: VideoStatus,
  reason: string | null
): Promise<{ userId: string; filename: string | null } | null> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ user_id: string; filename: string | null }>(
    `UPDATE video_submission
     SET status = $2, reject_reason = $3
     WHERE id = $1
     RETURNING user_id, filename`,
    [id, status, status === 'rejected' ? reason : null]
  )
  const r = rows[0]
  if (!r) return null
  return { userId: r.user_id, filename: r.filename }
}

// ── Admin → user messages ────────────────────────────────────────────────────

export interface UserMessage {
  id: number
  body: string
  created_at: string
}

// targetUserId null = broadcast to every user.
export async function addAdminMessage(
  targetUserId: string | null,
  body: string
): Promise<number> {
  await ensureAdminTables()
  // Returns the row id so a caller that sends a message as part of a reversible
  // action (marking a payment) can withdraw it again on undo.
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO admin_message (target_user_id, body) VALUES ($1, $2) RETURNING id',
    [targetUserId, body]
  )
  return Number(rows[0]?.id ?? 0)
}

// Messages a user hasn't dismissed yet (broadcast or addressed to them).
export async function getUnreadMessages(userId: string): Promise<UserMessage[]> {
  await ensureAdminTables()
  const { rows } = await pool.query<{ id: string; body: string; created_at: string }>(
    `SELECT m.id, m.body, m.created_at::text AS created_at
     FROM admin_message m
     WHERE (m.target_user_id IS NULL OR m.target_user_id = $1)
       AND NOT EXISTS (
         SELECT 1 FROM message_read r WHERE r.message_id = m.id AND r.user_id = $1
       )
     ORDER BY m.created_at DESC`,
    [userId]
  )
  return rows.map((r) => ({ id: Number(r.id), body: r.body, created_at: r.created_at }))
}

export async function markMessageRead(userId: string, messageId: number): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    'INSERT INTO message_read (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [messageId, userId]
  )
}

// A user replies to an admin message. Only allowed for a message addressed to
// them (or a broadcast).
export async function addMessageReply(
  userId: string,
  messageId: number,
  body: string
): Promise<boolean> {
  await ensureAdminTables()
  const { rows } = await pool.query(
    `SELECT 1 FROM admin_message WHERE id = $1 AND (target_user_id IS NULL OR target_user_id = $2)`,
    [messageId, userId]
  )
  if (rows.length === 0) return false
  await pool.query(
    'INSERT INTO message_reply (message_id, user_id, body) VALUES ($1, $2, $3)',
    [messageId, userId, body]
  )
  return true
}

// Admin: delete a single reply.
export async function deleteMessageReply(replyId: number): Promise<void> {
  await ensureAdminTables()
  await pool.query('DELETE FROM message_reply WHERE id = $1', [replyId])
}

// Admin: delete a message and everything tied to it (replies + read receipts).
export async function deleteAdminMessage(messageId: number): Promise<void> {
  await ensureAdminTables()
  await pool.query('DELETE FROM message_reply WHERE message_id = $1', [messageId])
  await pool.query('DELETE FROM message_read WHERE message_id = $1', [messageId])
  await pool.query('DELETE FROM admin_message WHERE id = $1', [messageId])
}

export async function addCommentedSubmission(
  userId: string,
  platform: string,
  count: number,
  sampleUrl: string | null
): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    'INSERT INTO commented_submission (user_id, platform, count, sample_url) VALUES ($1, $2, $3, $4)',
    [userId, platform, count, sampleUrl]
  )
}

export async function addScreenshot(userId: string, platform: string, blobUrl: string): Promise<void> {
  await ensureAdminTables()
  await pool.query(
    'INSERT INTO comment_screenshot (user_id, platform, blob_url) VALUES ($1, $2, $3)',
    [userId, platform, blobUrl]
  )
}

export interface AdminUserRow {
  id: string
  name: string
  email: string
  image: string | null
  createdAt: string
  product: string | null
  profile: UserProfile | null
  clicksByPlatform: Record<string, number>
  totalClicks: number
  commentedByPlatform: Record<string, number>
  totalCommented: number
  sampleUrls: Record<string, string[]>
  loginDays: string[]
  dailyClicks: { day: string; count: number }[]
  dailyComments: { day: string; count: number }[]
  screenshots: { platform: string; url: string; uploaded_at: string }[]
  videoStatus: VideoStatus | null
  videoSubmissions: VideoSubmission[]
  promoLinks: { id: number; platform: string; url: string; paid: boolean; submitted_at: string }[]
  replies: { id: number; messageId: number; body: string; created_at: string; toMessage: string | null }[]
  validUntil: string | null // TikTok-comment verification: valid through this date (ISO), or null
  verifyFailed: boolean // a verification ran but did NOT find the account (→ warning)
  blocked: boolean // admin blocked this user from signing in / re-registering
  blockReason: BlockReason | null // why they're blocked (null when not blocked)
  /** True when the nightly presence check blocked them, not a person. */
  blockAuto: boolean
  lastSnapshotDay: string | null // day of this user's most recent saved past-state
}

// How many days the admin dashboard's daily-clicks table covers.
export const ADMIN_DAILY_CLICK_DAYS = 7

export interface AdminData {
  resetAt: string
  users: AdminUserRow[]
  /** Links clicked per product SINCE THE RESET — grouped by the product stamped
   *  on each click, so it is unaffected by users being reassigned later. */
  clicksByProduct: Record<string, number>
  /** Clicks per calendar day for the last ADMIN_DAILY_CLICK_DAYS days, all users.
   *  Zero-filled, oldest first, and NOT scoped to the reset (it is a rolling
   *  window). `byProduct` holds the same days split by the click's product. */
  dailyClicks: { day: string; count: number }[]
  dailyClicksByProduct: Record<string, { day: string; count: number }[]>
  /** The same days split by the PLATFORM stamped on each click. Separate
   *  from the product split: one says which product is advertised, the
   *  other which site the work happened on. */
  dailyClicksByPlatform: Record<string, { day: string; count: number }[]>
}

// Clicks per product since `resetAt`, plus the last N days of clicks (total and
// split by product). Kept out of getAdminData's big Promise.all so the shape
// stays readable; runs as one round-trip each.
async function getClickAggregates(resetAt: Date): Promise<{
  clicksByProduct: Record<string, number>
  dailyClicks: { day: string; count: number }[]
  dailyClicksByProduct: Record<string, { day: string; count: number }[]>
  dailyClicksByPlatform: Record<string, { day: string; count: number }[]>
}> {
  const days = ADMIN_DAILY_CLICK_DAYS
  const [totals, daily] = await Promise.all([
    pool.query<{ product: string; n: number }>(
      `SELECT COALESCE(NULLIF(cl.product, ''), '(none)') AS product, COUNT(*)::int AS n
         FROM clicked_link cl LEFT JOIN user_reset ur ON ur.user_id = cl.user_id
        WHERE cl.clicked_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
        GROUP BY 1`,
      [resetAt]
    ),
    // generate_series zero-fills days with no clicks, so the table always shows
    // the full window instead of silently skipping quiet days.
    pool.query<{ day: string; product: string | null; platform: string | null; n: number }>(
      `SELECT d::date::text AS day,
              COALESCE(NULLIF(cl.product, ''), '(none)') AS product,
              COALESCE(NULLIF(cl.platform, ''), '(none)') AS platform,
              COUNT(cl.id)::int AS n
         FROM generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, '1 day') d
         LEFT JOIN clicked_link cl ON cl.clicked_at::date = d::date
        GROUP BY 1, 2, 3 ORDER BY 1`,
      [days]
    ),
  ])

  const clicksByProduct: Record<string, number> = {}
  for (const r of totals.rows) clicksByProduct[r.product] = r.n

  // Every day in the window, in order — the series guarantees they all appear.
  const allDays = Array.from(new Set(daily.rows.map((r) => r.day))).sort()
  const zero = () => allDays.map((day) => ({ day, count: 0 }))
  const dailyTotals = zero()
  const byProduct: Record<string, { day: string; count: number }[]> = {}
  const byPlatform: Record<string, { day: string; count: number }[]> = {}
  const idx = new Map(allDays.map((d, i) => [d, i]))
  for (const r of daily.rows) {
    if (!r.n) continue // the LEFT JOIN's empty days come back as 0
    const i = idx.get(r.day)
    if (i === undefined) continue
    // One row per (day, product, platform) now, so a day's total is the sum of
    // its rows rather than a single row's count.
    dailyTotals[i].count += r.n
    ;(byProduct[r.product ?? '(none)'] ??= zero())[i].count += r.n
    ;(byPlatform[r.platform ?? '(none)'] ??= zero())[i].count += r.n
  }
  return {
    clicksByProduct,
    dailyClicks: dailyTotals,
    dailyClicksByProduct: byProduct,
    dailyClicksByPlatform: byPlatform,
  }
}

// Everything the admin dashboard needs, all scoped to "since the last reset".
export async function getAdminData(): Promise<AdminData> {
  await Promise.all([ensureAdminTables(), ensureClickedTable(), ensureUserProfileTable()])
  const resetAt = await getResetAt()

  const [
    users,
    clicks,
    daily,
    logins,
    commented,
    samples,
    shots,
    profiles,
    dailyComments,
    products,
    videoAccess,
    videoSubs,
    replies,
    promoLinkRows,
  ] = (
    await Promise.all([
      pool.query(`SELECT id, name, email, image, "createdAt"::text AS created_at FROM "user" ORDER BY "createdAt"`),
      pool.query(
        `SELECT cl.user_id, cl.platform, COUNT(*)::int AS n
         FROM clicked_link cl LEFT JOIN user_reset ur ON ur.user_id = cl.user_id
         WHERE cl.clicked_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
         GROUP BY cl.user_id, cl.platform`,
        [resetAt]
      ),
      pool.query(
        `SELECT cl.user_id, cl.clicked_at::date::text AS day, COUNT(*)::int AS n
         FROM clicked_link cl LEFT JOIN user_reset ur ON ur.user_id = cl.user_id
         WHERE cl.clicked_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
         GROUP BY cl.user_id, day ORDER BY day`,
        [resetAt]
      ),
      pool.query(
        `SELECT uld.user_id, uld.day::text AS day
         FROM user_login_day uld LEFT JOIN user_reset ur ON ur.user_id = uld.user_id
         WHERE uld.day >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))::date
         ORDER BY day`,
        [resetAt]
      ),
      pool.query(
        `SELECT cs.user_id, cs.platform, COALESCE(SUM(cs.count), 0)::int AS n
         FROM commented_submission cs LEFT JOIN user_reset ur ON ur.user_id = cs.user_id
         WHERE cs.submitted_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
         GROUP BY cs.user_id, cs.platform`,
        [resetAt]
      ),
      pool.query(
        `SELECT cs.user_id, cs.platform, cs.sample_url
         FROM commented_submission cs LEFT JOIN user_reset ur ON ur.user_id = cs.user_id
         WHERE cs.submitted_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
           AND cs.sample_url IS NOT NULL AND cs.sample_url <> ''
         ORDER BY cs.submitted_at`,
        [resetAt]
      ),
      pool.query(
        `SELECT cst.user_id, cst.platform, cst.blob_url, cst.uploaded_at::text AS uploaded_at
         FROM comment_screenshot cst LEFT JOIN user_reset ur ON ur.user_id = cst.user_id
         WHERE cst.uploaded_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
         ORDER BY cst.uploaded_at`,
        [resetAt]
      ),
      pool.query(
        `SELECT user_id, name, bank_account, tiktok_url, youtube_url, instagram_url FROM user_profile`
      ),
      pool.query(
        `SELECT cs.user_id, cs.submitted_at::date::text AS day, COALESCE(SUM(cs.count), 0)::int AS n
         FROM commented_submission cs LEFT JOIN user_reset ur ON ur.user_id = cs.user_id
         WHERE cs.submitted_at >= GREATEST($1::timestamptz, COALESCE(ur.reset_at, $1::timestamptz))
         GROUP BY cs.user_id, day ORDER BY day`,
        [resetAt]
      ),
      pool.query(`SELECT user_id, product FROM user_product`),
      pool.query(`SELECT user_id, status FROM video_access`),
      pool.query(
        `SELECT user_id, id, url, filename, size, paid, status, reject_reason, uploaded_at::text AS uploaded_at
         FROM video_submission ORDER BY uploaded_at DESC`
      ),
      pool.query(
        `SELECT r.id, r.user_id, r.message_id, r.body, r.created_at::text AS created_at, m.body AS to_message
         FROM message_reply r LEFT JOIN admin_message m ON m.id = r.message_id
         ORDER BY r.created_at DESC`
      ),
      pool.query(
        `SELECT user_id, id, platform, url, paid, submitted_at::text AS submitted_at
         FROM promo_link ORDER BY submitted_at DESC`
      ),
    ])
  ).map((r) => r.rows) as [
    { id: string; name: string | null; email: string; image: string | null; created_at: string }[],
    { user_id: string; platform: string; n: number }[],
    { user_id: string; day: string; n: number }[],
    { user_id: string; day: string }[],
    { user_id: string; platform: string; n: number }[],
    { user_id: string; platform: string; sample_url: string }[],
    { user_id: string; platform: string; blob_url: string; uploaded_at: string }[],
    (UserProfile & { user_id: string })[],
    { user_id: string; day: string; n: number }[],
    { user_id: string; product: string }[],
    { user_id: string; status: string }[],
    {
      user_id: string
      id: string
      url: string
      filename: string | null
      size: string | null
      paid: boolean
      status: string
      reject_reason: string | null
      uploaded_at: string
    }[],
    { id: string; user_id: string; message_id: string; body: string; created_at: string; to_message: string | null }[],
    { user_id: string; id: string; platform: string; url: string; paid: boolean; submitted_at: string }[],
  ]

  const byId = new Map<string, AdminUserRow>()
  for (const u of users) {
    byId.set(u.id, {
      id: u.id,
      name: u.name ?? '',
      email: u.email,
      image: u.image,
      createdAt: u.created_at,
      product: null,
      profile: null,
      clicksByPlatform: {},
      totalClicks: 0,
      commentedByPlatform: {},
      totalCommented: 0,
      sampleUrls: {},
      loginDays: [],
      dailyClicks: [],
      dailyComments: [],
      screenshots: [],
      videoStatus: null,
      videoSubmissions: [],
      promoLinks: [],
      replies: [],
      validUntil: null,
      verifyFailed: false,
      blocked: false,
      blockReason: null,
      blockAuto: false,
      lastSnapshotDay: null,
    })
  }

  // TikTok-verification validity (separate lightweight query so the big tuple
  // above stays untouched).
  const validity = await getAllUserValidity().catch(
    () => ({}) as Record<string, { validUntil: string | null; checkedAt: string | null }>
  )
  for (const [uid, v] of Object.entries(validity)) {
    const u = byId.get(uid)
    if (u) {
      u.validUntil = v.validUntil
      // A row with a checked_at but no valid_until = a verification ran and did
      // NOT find the account.
      u.verifyFailed = !v.validUntil && !!v.checkedAt
    }
  }

  // Most recent saved past-state per user (for the "past states" button label).
  const latestSnapshots = await getLatestSnapshotByUser().catch(
    () => ({}) as Record<string, { day: string; created_at: string }>
  )
  for (const [uid, s] of Object.entries(latestSnapshots)) {
    const u = byId.get(uid)
    if (u) u.lastSnapshotDay = s.day
  }

  // Blocked users (matched by sign-in email) + their reason.
  const blockedByEmail = await getBlockedByEmail().catch(
    () => new Map<string, { reason: BlockReason; auto: boolean }>()
  )
  if (blockedByEmail.size) {
    for (const u of Array.from(byId.values())) {
      const hit = u.email ? blockedByEmail.get(u.email.toLowerCase()) : undefined
      if (hit) {
        u.blocked = true
        u.blockReason = hit.reason
        u.blockAuto = hit.auto
      }
    }
  }

  for (const p of profiles) {
    const u = byId.get(p.user_id)
    if (u)
      u.profile = {
        name: p.name,
        bank_account: p.bank_account,
        tiktok_url: p.tiktok_url,
        youtube_url: p.youtube_url,
        instagram_url: p.instagram_url,
      }
  }
  for (const c of clicks) {
    const u = byId.get(c.user_id)
    if (u) {
      u.clicksByPlatform[c.platform] = c.n
      u.totalClicks += c.n
    }
  }
  for (const d of daily) {
    const u = byId.get(d.user_id)
    if (u) u.dailyClicks.push({ day: d.day, count: d.n })
  }
  for (const d of dailyComments) {
    const u = byId.get(d.user_id)
    if (u) u.dailyComments.push({ day: d.day, count: d.n })
  }
  for (const pr of products) {
    const u = byId.get(pr.user_id)
    if (u) u.product = pr.product
  }
  for (const va of videoAccess) {
    const u = byId.get(va.user_id)
    if (u) u.videoStatus = va.status as VideoStatus
  }
  for (const vs of videoSubs) {
    const u = byId.get(vs.user_id)
    if (u)
      u.videoSubmissions.push({
        id: Number(vs.id),
        url: vs.url,
        filename: vs.filename,
        size: Number(vs.size ?? 0),
        paid: vs.paid,
        status: (vs.status as VideoStatus) ?? 'pending',
        reject_reason: vs.reject_reason ?? null,
        uploaded_at: vs.uploaded_at,
      })
  }
  for (const pl of promoLinkRows) {
    const u = byId.get(pl.user_id)
    if (u)
      u.promoLinks.push({
        id: Number(pl.id),
        platform: pl.platform,
        url: pl.url,
        paid: pl.paid,
        submitted_at: pl.submitted_at,
      })
  }
  for (const rp of replies) {
    const u = byId.get(rp.user_id)
    if (u)
      u.replies.push({
        id: Number(rp.id),
        messageId: Number(rp.message_id),
        body: rp.body,
        created_at: rp.created_at,
        toMessage: rp.to_message,
      })
  }
  for (const l of logins) {
    const u = byId.get(l.user_id)
    if (u) u.loginDays.push(l.day)
  }
  for (const c of commented) {
    const u = byId.get(c.user_id)
    if (u) {
      u.commentedByPlatform[c.platform] = c.n
      u.totalCommented += c.n
    }
  }
  for (const s of samples) {
    const u = byId.get(s.user_id)
    if (u) (u.sampleUrls[s.platform] ??= []).push(s.sample_url)
  }
  for (const s of shots) {
    const u = byId.get(s.user_id)
    if (u) u.screenshots.push({ platform: s.platform, url: s.blob_url, uploaded_at: s.uploaded_at })
  }

  const aggregates = await getClickAggregates(resetAt).catch(() => ({
    clicksByProduct: {} as Record<string, number>,
    dailyClicks: [] as { day: string; count: number }[],
    dailyClicksByProduct: {} as Record<string, { day: string; count: number }[]>,
    dailyClicksByPlatform: {} as Record<string, { day: string; count: number }[]>,
  }))

  return { resetAt: resetAt.toISOString(), users: Array.from(byId.values()), ...aggregates }
}
