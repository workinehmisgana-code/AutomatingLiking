// Scoring how often a user's comment is actually present on the links they open.
//
// A click only says a link was opened. This reads the video's comments and looks
// for the user's own @handle, so "opened 300 links" can be checked against
// "commented on 300 links" instead of taken on trust.
//
// Shared by the nightly cron and the admin sweep so both score identically —
// two definitions of the same percentage would be worse than none.
//
// EVERY link of the day is read, not a sample. One user can open 160 links, so
// the work outlives any single request: judged links are written to a ledger
// (comment_presence_link) and a resumed pass skips what is already there.

import { fetchComments } from './linkStats'
import {
  BLOCK_RULE_BOUNDS,
  BLOCK_RULE_DEFAULTS,
  clampRule,
  genreOfProduct,
  type BlockRules,
} from './config'
import {
  getBlockRules,
  getClickedOnDay,
  getJudgedLinks,
  saveJudgedLinks,
  getRecentClickedLinks,
  getJudgedVerdicts,
  getRecentJudgedRate,
  getRecentJudgedByProduct,
  setGenrePauses,
  recordTiktokAccount,
} from './db'
import { ensureGenreRegistry } from './genreStore'


/**
 * Comment reads in flight at once.
 *
 * TikTok's comment endpoint is slow and erratic (1–5s, occasionally ~19), and
 * concurrency is what makes reading a whole day feasible: measured serially it
 * managed 0.2 links/sec, against 0.7/sec with several in flight. Kept modest so
 * a sweep does not look like an attack.
 */
const CONCURRENCY = 4

// A DAY IS CHECKED IN FULL. Every link the user opened that day is read.
//
// There used to be a cap of 100, taken on an even stride so the sample covered
// the whole day rather than just the evening. It made a percentage cheap but it
// also made it an estimate, and an estimate is a poor basis for blocking
// someone: on the last 30 days, 61% of user-days ran past 100 links and the
// biggest was 1,373, so most days were being judged on a fraction of themselves
// and the missing part was never looked at.
//
// The cost is real — roughly twice the TikTok reads — but the sweep is
// deadline-bounded and resumable: it judges what it can before the deadline,
// writes what it judged, and the next pass picks up where it stopped. A bigger
// day therefore takes more passes, not a longer request.

/** Comment pages per link (50 each). Deep enough for a typical video. */
const MAX_PAGES = 4

/** The @handle in a TikTok profile URL, lowercased, without the '@'. */
export function handleFromProfile(url: string): string | null {
  const m = (url || '').match(/@([^/?#\s]+)/)
  return m?.[1] ? m[1].toLowerCase() : null
}

export interface JudgedLink {
  url: string
  found: boolean
  judgeable: boolean
  /** The matching comment's text when found. Kept so the admin can read what
   *  the user actually posted instead of taking a boolean on trust. */
  text?: string | null
  /** How many comments TikTok says the video has, free from the same read. */
  total?: number | null
  /** The commenter's numeric TikTok id, when found. Only the comment list
   *  carries it, and it dates the account — see lib/tiktokId. */
  uid?: string | null
}

export interface PresenceResult {
  checked: number
  found: number
  skipped: number
  pct: number | null
  links: JudgedLink[]
}

/**
 * Judge one link: is this user's handle among its commenters?
 *
 * A HIT is conclusive even on a partial read — we saw the comment. A MISS only
 * counts when every comment was readable; otherwise the link is not judgeable
 * and is left out of the score rather than held against the user.
 */
async function judge(username: string, url: string): Promise<JudgedLink> {
  const read = await fetchComments(url, MAX_PAGES)
  const hit = read.unresolved ? undefined : read.comments.find((c) => c.username === username)
  const found = hit !== undefined
  return {
    url,
    found,
    judgeable: found || (!read.unresolved && read.complete),
    // Recorded at judging time because re-reading later is a second request
    // against a rate limit we are already close to.
    text: hit?.text ?? null,
    total: read.total,
    uid: hit?.uid || null,
  }
}

/**
 * Store the account id from whichever judged link found the user's comment.
 *
 * Free — the id was already in the payload that judged the link. Failing to
 * record it must never fail the judging, so this swallows its own errors.
 */
async function rememberAccount(userId: string, username: string, judged: JudgedLink[]) {
  const uid = judged.find((l) => l.found && l.uid)?.uid
  if (uid) await recordTiktokAccount(userId, username, uid).catch(() => {})
}

/**
 * Judge a batch of links with a fixed number of reads in flight.
 *
 * Stops starting new reads at `deadline` and returns what finished, so a caller
 * bounded by a request timeout always gets usable results back and can resume
 * from the links it did not reach.
 */
export async function judgeLinks(
  username: string,
  links: string[],
  deadline: number
): Promise<JudgedLink[]> {
  const out: JudgedLink[] = []
  let next = 0
  const worker = async () => {
    for (;;) {
      // At least one link always runs, or a caller with no time left would loop
      // forever making no progress.
      if (out.length > 0 && Date.now() >= deadline) return
      const i = next++
      if (i >= links.length) return
      out.push(await judge(username, links[i]))
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, links.length || 1) }, worker))
  return out
}

/** Roll judged links up into a day's score. */
export function tally(links: JudgedLink[]): PresenceResult {
  const checked = links.filter((l) => l.judgeable).length
  const found = links.filter((l) => l.found).length
  return {
    checked,
    found,
    skipped: links.length - checked,
    pct: checked > 0 ? Math.round((100 * found) / checked) : null,
    links,
  }
}

/**
 * Judge every link a user opened on one day, resuming where a previous pass
 * stopped, and refresh the stored day score.
 *
 * Returns how many links remain, so a caller can keep coming back until zero.
 *
 * `freshSince` decides what counts as already done. A verdict recorded before
 * that instant is treated as UNJUDGED and the link is read again — so a sweep
 * reports what the video says now, not what some earlier pass concluded. A
 * comment can be deleted, shadow-hidden or posted late, and none of that shows
 * in a stored boolean. Pass the moment the current pass began: links it judged
 * itself are reused (which is what makes a long pass resumable), everything
 * older is re-read.
 */
export async function scoreUserDay(
  userId: string,
  tiktokUrl: string,
  day: string,
  deadline: number,
  freshSince?: string | null
): Promise<{ judged: number; remaining: number; total: number; opened: number } | null> {
  const username = handleFromProfile(tiktokUrl)
  if (!username) return null
  const opened = await getClickedOnDay(userId, day).catch(() => [] as string[])
  if (opened.length === 0) return null
  // Every link opened that day, not a sample of them — see the note above.
  const all = opened

  const done = await getJudgedLinks(userId, day, freshSince).catch(() => new Set<string>())
  const todo = all.filter((u) => !done.has(u))
  if (todo.length === 0) {
    return { judged: 0, remaining: 0, total: all.length, opened: opened.length }
  }

  const judged = await judgeLinks(username, todo, deadline)
  await saveJudgedLinks(userId, day, judged, freshSince)
  await rememberAccount(userId, username, judged)
  return {
    judged: judged.length,
    remaining: todo.length - judged.length,
    total: all.length,
    opened: opened.length,
  }
}

/**
 * How many of a user's most recent links the per-user check reads.
 *
 * The admin's "verify" button used to read ONE DAY — the user's last active day,
 * in full. That was the wrong population for the question it is pressed to
 * answer. A day is whatever length it happens to be: a quiet day gave a verdict
 * on eleven links, and a heavy one needed a dozen resumed passes to get through
 * 1,373. Neither is "is this person doing the work".
 *
 * Their most recent links, across however many days they span, is the same
 * question asked the same way for everybody, and it is the population the
 * auto-block rules already sample from.
 *
 * THREE HUNDRED, TO FEED A TWO HUNDRED DENOMINATOR. The rate rule below needs
 * RATIO_SAMPLE judged links before it may say anything, and a read is not a
 * judgement: a dead video, a restricted account or a throttled page is skipped,
 * and measured across real days about 15% are — 250 links read gave 210 judged,
 * 276 gave 244, 345 gave 305. At that rate 300 reads yield roughly 255 judged,
 * comfortably past 200, while 200 reads would land near 170 and leave the rule
 * permanently unable to speak.
 *
 * It costs what it costs: 300 videos at a few seconds each is minutes of reading,
 * spread over several resumed requests. That is the price of a number that can
 * block somebody.
 */
export const RECENT_SAMPLE = 300

/**
 * Judge a user's most recent links, newest first, spanning days.
 *
 * Same reads, same judging and same ledger as the per-day sweep — only the
 * population differs. Resumable in the same way: it judges what it can before
 * the deadline and reports how many are left.
 *
 * THE DAY SCORES ARE LEFT ALONE BY DEFAULT. Every verdict is written to the
 * ledger, because a reading is a reading and the next sweep should not repeat it,
 * but the per-day score rows are not recomputed from this sample — see refreshDay
 * in saveJudgedLinks. A sample spread over five days is a slice of each of them,
 * and a slice must not be allowed to redefine a day.
 *
 * `refreshDays` is for the one caller where that reasoning inverts: the nightly
 * cron, which is now the ONLY pass that reads these links. Left alone, the per-day
 * history would simply stop being written. So the cron asks for the touched days
 * to be recomputed from EVERY verdict the ledger holds for them — never from this
 * pass alone, which is what would shrink a 400-link day to the nine of its links
 * that fell inside the window.
 */
export async function scoreUserRecent(
  userId: string,
  tiktokUrl: string,
  limit: number,
  deadline: number,
  freshSince?: string | null,
  /** Recompute the day rows this pass touched, from the whole ledger. */
  refreshDays = false,
  /**
   * The window as it stood at this instant, so a user who keeps clicking cannot
   * push the links already judged out of it. See getRecentClickedLinks.
   */
  before?: string | null
): Promise<{
  judged: number
  remaining: number
  total: number
  days: string[]
  links: (JudgedLink & { day: string })[]
} | null> {
  const username = handleFromProfile(tiktokUrl)
  if (!username) return null
  const recent = await getRecentClickedLinks(userId, limit, before).catch(
    () => [] as { url: string; day: string }[]
  )
  if (recent.length === 0) return null

  // What this check has already judged. Anything older than freshSince counts as
  // unjudged and is read again, so the answer is about now.
  const done = await getJudgedVerdicts(userId, recent, freshSince).catch(
    () => new Map<string, { found: boolean; judgeable: boolean }>()
  )
  const todo = recent.filter((r) => !done.has(`${r.day}|${r.url}`))

  // ONE READ PER URL, not per row. The same video can be in the list twice —
  // clicked on two days — and it has one comment section either way.
  const byUrl = new Map<string, string[]>()
  for (const r of todo) byUrl.set(r.url, [...(byUrl.get(r.url) ?? []), r.day])
  const judged = todo.length
    ? await judgeLinks(username, Array.from(byUrl.keys()), deadline)
    : []

  // Written per day, because the ledger is keyed by day — a verdict for a url
  // that appears on two days is recorded against both.
  const perDay = new Map<string, JudgedLink[]>()
  for (const l of judged) {
    for (const day of byUrl.get(l.url) ?? []) {
      perDay.set(day, [...(perDay.get(day) ?? []), l])
    }
  }
  for (const day of Array.from(perDay.keys())) {
    // NO freshSince WHEN REFRESHING A DAY: the row is rebuilt from everything the
    // ledger knows about that day, not from this pass's slice of it.
    await saveJudgedLinks(
      userId,
      day,
      perDay.get(day) ?? [],
      refreshDays ? null : freshSince,
      refreshDays
    )
  }
  await rememberAccount(userId, username, judged)

  // The report is over the SAMPLE, in the order the user opened it: this pass's
  // verdicts plus the ones it made on an earlier request. Both carry the comment
  // they found — a report that can only say "commented" asks the admin to take a
  // boolean on trust.
  const fresh = new Map(judged.map((l) => [l.url, l]))
  const links: (JudgedLink & { day: string })[] = []
  for (const r of recent) {
    const got = fresh.get(r.url) ?? done.get(`${r.day}|${r.url}`)
    if (got) links.push({ ...got, url: r.url, day: r.day })
  }
  return {
    judged: judged.length,
    // Counted in urls, which is what the work is measured in.
    remaining: byUrl.size - judged.length,
    total: recent.length,
    days: Array.from(new Set(recent.map((r) => r.day))).sort(),
    links,
  }
}

// ── Automatic blocking ───────────────────────────────────────────────────────
// A user whose comment appears on NONE of a large sample of the links they
// opened is claiming work they did not do — or is posting from an account whose
// comments nobody can see, which earns nothing either way.
//
// The rule is deliberately hard to trip:
//
//  * the sample must reach the required number of JUDGED links — 50 by default,
//    and settable per sweep from the dashboard. A light day is topped up from
//    earlier days rather than judged on a handful.
//  * links that could not be judged do not count toward it, and do not stop it
//    either: the search keeps walking back through earlier links until 50 have
//    actually been judged. A TikTok outage produces skips, not misses, so it
//    can never manufacture a block — but it can no longer prevent one, which
//    is what used to happen, since a single unreadable link in a 50-link
//    sample left the count at 49 forever.
//  * a single found comment anywhere in the sample stops it dead.
//
// The admin can unblock from the dashboard; nothing here is irreversible.

/**
 * Judged links required before a no-comments verdict may block anyone.
 *
 * THE DEFAULT, not the rule. All three numbers below are settable on the admin
 * dashboard and stored in app_kv; these are what a fresh database uses and what a
 * caller gets if it asks for a verdict without reading the settings. The bounds
 * and the reasons for them are in lib/config (BLOCK_RULE_BOUNDS).
 */
export const BLOCK_SAMPLE = BLOCK_RULE_DEFAULTS.sample

/**
 * THE SECOND RULE: a rate, not an absence.
 *
 * Nothing found on fifty links catches somebody who posts nothing. It does not
 * catch somebody who posts occasionally and claims to have worked all day — one
 * comment in two hundred clears the first rule completely, and on the real data
 * five people sat in exactly that gap: 1, 2, 7, 10 and 15 comments found across
 * 200 judged links.
 *
 * So: fewer than a tenth of their last two hundred judged links carrying their
 * comment is also a block.
 *
 * TEN PERCENT IS NOT A GUESS. Measured across every user with 200 judged links,
 * the distribution has a hole in it — eight users sit at 0–8% and everybody else
 * starts at 11%, running up to 36%. The threshold sits in that gap, so it
 * separates two groups that were already separate rather than cutting through a
 * crowd.
 *
 * THE DENOMINATOR IS JUDGED LINKS, and it must be reached before the rule may
 * speak: a user with 170 judged links is not judged on 170, they are not judged at
 * all. Unreadable links are in neither half of the fraction.
 */
export const RATIO_SAMPLE = BLOCK_RULE_DEFAULTS.ratioSample
export const RATIO_MIN_PCT = BLOCK_RULE_DEFAULTS.ratioMinPct
/** Recent links to look back over to find RATIO_SAMPLE judged ones. */
const RATIO_POOL = 500

/**
 * Bounds on a sample the admin chooses for a sweep.
 *
 * The floor is not arbitrary. A block is irreversible-feeling to the person on
 * the receiving end, and the smaller the sample the more likely an honest worker
 * trips it — TikTok hides comments, paging cuts others off, and a run of ten
 * unlucky links is not evidence of anything.
 *
 * The ceiling follows from the candidate pool: finding N judgeable links needs
 * roughly 6N recent ones, and getRecentClickedLinks caps at 500, so above ~83 the
 * search runs out of links to look at and the count stalls short of the target
 * forever — which reads as "never blocks anyone" and would be blamed on the rule
 * rather than on the cap.
 */
export const MIN_BLOCK_SAMPLE = BLOCK_RULE_BOUNDS.sample.min
export const MAX_BLOCK_SAMPLE = BLOCK_RULE_BOUNDS.sample.max

/**
 * Clamp a requested sample into the range that can actually be satisfied.
 *
 * Nothing, or nothing readable, means the default — NOT the floor. Number('')
 * is 0, so clamping straight away turned an empty field into 20, the harshest
 * setting there is: clear the box to retype and the next sweep would block
 * people on twenty links. A missing value has to mean "unchanged", because the
 * mistake it guards against is irreversible for whoever it lands on.
 */
export function clampBlockSample(n: unknown): number {
  // ONE CLAMP. This used to hold its own copy of the same rules the settings now
  // use, and two copies of a bound is two bounds waiting to disagree.
  return clampRule(n, 'sample')
}

// How many recent links to consider in order to FIND that many judgeable ones.
// Dead videos, restricted accounts and throttled reads all produce skips, and
// roughly a third of reads come back incomplete, so the candidate pool has to
// be several times the target or the count stalls short of it. Capped at 500 by
// getRecentClickedLinks; only as many as needed are ever actually judged.
const candidatePool = (sample: number) => sample * 6

export interface BlockVerdict {
  judged: number
  found: number
  /** Links looked at but not judgeable — reported so a near-miss is explicable. */
  skipped: number
  block: boolean
  /**
   * Which rule decided it, so a report can say why rather than just "blocked".
   *
   *   empty   nothing found on BLOCK_SAMPLE judged links
   *   ratio   under RATIO_MIN_PCT% of RATIO_SAMPLE judged links
   *   genres  under genreMinPct% in every genre they have enough judged links in
   */
  rule?: 'empty' | 'ratio' | 'genres'
  /**
   * The genre rule's reading: each genre's rate over their recent judged links,
   * and which genres it paused or lifted. A genre under the threshold while
   * another is above it is paused — not served to them — rather than blocked.
   */
  genres?: GenreVerdict
  /** The rate over their last RATIO_SAMPLE judged links, when it could be read. */
  ratio?: { judged: number; found: number; pct: number } | null
  /** The thresholds this verdict was reached under, for the report. */
  rules?: BlockRules
}

export interface GenreRate {
  genre: string
  judged: number
  found: number
  pct: number
  /** Enough judged links for the rule to speak about this genre. */
  scored: boolean
  /** Scored and under the threshold. */
  below: boolean
}

export interface GenreVerdict {
  rates: GenreRate[]
  /** Genres paused by this verdict (not served to the worker from now on). */
  paused: string[]
  /** Genres that recovered, so their pause was lifted. */
  lifted: string[]
  /** At least one scored genre is at or above the threshold. */
  anyPassing: boolean
}

/**
 * The numbers a block is reported with, by the rule that made it: the rate
 * rule's window, the genre rule's scored genres together, or the empty rule's
 * judged count.
 */
export function verdictFigures(v: BlockVerdict): { judged: number; pct: number | null } {
  if (v.rule === 'ratio') return { judged: v.ratio?.judged ?? 0, pct: v.ratio?.pct ?? null }
  if (v.rule === 'genres') {
    const s = (v.genres?.rates ?? []).filter((r) => r.scored)
    const judged = s.reduce((a, r) => a + r.judged, 0)
    const found = s.reduce((a, r) => a + r.found, 0)
    return { judged, pct: judged > 0 ? Math.round((100 * found) / judged) : 0 }
  }
  return { judged: v.judged, pct: v.ratio?.pct ?? null }
}

/** This worker's recent rate in each genre, from the ledger (no TikTok reads). */
async function genreRates(userId: string, rules: BlockRules): Promise<GenreRate[]> {
  // Custom genres' products have to be known before genreOfProduct can place them.
  await ensureGenreRegistry().catch(() => {})
  const rows = await getRecentJudgedByProduct(userId, RATIO_POOL).catch(() => [])
  const by = new Map<string, { judged: number; found: number }>()
  for (const r of rows) {
    const g = genreOfProduct(r.product)
    const e = by.get(g) ?? { judged: 0, found: 0 }
    e.judged += r.judged
    e.found += r.found
    by.set(g, e)
  }
  return Array.from(by.entries()).map(([genre, e]) => {
    const pct = e.judged > 0 ? Math.round((100 * e.found) / e.judged) : 0
    const scored = e.judged >= rules.genreSample
    return { genre, judged: e.judged, found: e.found, pct, scored, below: scored && pct < rules.genreMinPct }
  })
}

/**
 * Decide whether a user should be auto-blocked, judging any of their recent
 * links that the ledger does not already cover.
 *
 * Returns `block: false` whenever the sample is too small — including when the
 * deadline cut the judging short. Insufficient evidence is never a block.
 */
export async function noCommentVerdict(
  userId: string,
  tiktokUrl: string,
  deadline: number,
  /**
   * Judged links required before a block, when the caller wants to override the
   * saved setting for one run — the manual sweep offers it as a field. Left out,
   * the admin's saved value is used, which is what the cron and the per-user
   * button do.
   */
  sample?: number,
  /**
   * The same pinned window the scoring pass used. It has to be the same instant
   * or the two disagree about which links the verdict is about: the pass can
   * report a finished window while this one reads three hundred links it has
   * never seen, and the rule then judges a sample that was never checked.
   */
  before?: string | null
): Promise<BlockVerdict> {
  const empty: BlockVerdict = { judged: 0, found: 0, skipped: 0, block: false }
  const username = handleFromProfile(tiktokUrl)
  if (!username) return empty

  // ONE SOURCE FOR THE THRESHOLDS. Read here rather than passed in by each
  // caller, so the cron, the manual sweep and the verify button cannot be running
  // three different rules — which is exactly what happened while the sweep took a
  // field for the sample and the other two used the constant.
  const rules = await getBlockRules().catch(() => ({ ...BLOCK_RULE_DEFAULTS }))
  // OFF MEANS OFF, for every rule and every caller. A switch that only stopped
  // the cron would be worse than none.
  if (!rules.on) return { ...empty, rules }
  const need = sample ?? rules.sample

  // Newest first, across days, so a short day is topped up from earlier ones.
  // Deliberately more than BLOCK_SAMPLE: skipped links have to be replaced by
  // older ones, not merely subtracted from the total.
  const recent = await getRecentClickedLinks(userId, candidatePool(need), before).catch(
    () => []
  )
  if (recent.length < need) return { ...empty, rules }

  const known = await getJudgedVerdicts(userId, recent).catch(
    () => new Map<string, { found: boolean; judgeable: boolean }>()
  )

  let judged = 0
  let found = 0
  let skipped = 0
  const pending: { url: string; day: string }[] = []

  // Whatever the ledger already knows costs nothing, so count all of it first.
  for (const r of recent) {
    const v = known.get(`${r.day}|${r.url}`)
    if (!v) {
      pending.push(r)
    } else if (v.judgeable) {
      judged++
      if (v.found) found++
    } else {
      skipped++
    }
  }

  // Judge only as far as the verdict needs. Newest first, in the order the
  // links were opened, stopping the moment one comment turns up — a single hit
  // settles it, and judging the rest would just spend requests on an answer we
  // already have.
  let i = 0
  while (found === 0 && judged < need && i < pending.length) {
    if (Date.now() >= deadline) break
    // `recent` is ordered by click time, so one day's links are contiguous.
    const day = pending[i].day
    let j = i
    while (j < pending.length && pending[j].day === day) j++
    const want = need - judged
    const slice = pending.slice(i, Math.min(j, i + want))
    i += slice.length

    const verdicts = await judgeLinks(username, slice.map((x) => x.url), deadline)
    if (verdicts.length > 0) await saveJudgedLinks(userId, day, verdicts).catch(() => {})
    await rememberAccount(userId, username, verdicts)
    for (const v of verdicts) {
      if (v.judgeable) {
        judged++
        if (v.found) found++
      } else {
        skipped++
      }
    }
    // The deadline can cut judgeLinks short. Without this the loop would spin
    // on the same slice, re-judging links it never got answers for.
    if (verdicts.length < slice.length) break
  }

  // ── the genre rule, read first because it can overrule the other two ───
  //
  // ONE GENRE GOOD IS NOT A BLOCK. A worker who comments on the humanizer links
  // and not on the slides ones is doing the job on humanizer: they stop being
  // given slides links, and keep the rest. Only when EVERY genre with enough
  // judged links is under the threshold does the rule block — and then neither
  // of the older rules is needed to say so.
  const rates = await genreRates(userId, rules).catch(() => [] as GenreRate[])
  const scored = rates.filter((r) => r.scored)
  const anyPassing = scored.some((r) => !r.below)
  const genres: GenreVerdict = { rates, paused: [], lifted: [], anyPassing }
  if (scored.length > 0 && !anyPassing) {
    return { judged, found, skipped, block: true, rule: 'genres', genres, rules }
  }
  // Some genre is good: pause the bad ones and lift any that recovered. A
  // genre too small to score keeps whatever it had — a paused genre gets no new
  // links, so waiting for fresh evidence on it would wait for ever; the admin
  // lifts it from the user's row.
  if (anyPassing) {
    const pause = scored.filter((r) => r.below)
    const lift = scored.filter((r) => !r.below).map((r) => r.genre)
    await setGenrePauses(userId, pause, lift).catch(() => {})
    genres.paused = pause.map((r) => r.genre)
    genres.lifted = lift
  }

  // ── rule one: nothing at all on a sample of links ──────────────────────
  // Not while a genre passes: the newest links can all be one bad genre's.
  if (judged >= need && found === 0 && !anyPassing) {
    return { judged, found, skipped, block: true, rule: 'empty', genres, rules }
  }

  // ── rule two: something, but almost nothing ────────────────────────────
  //
  // Read from the ledger, so it costs no requests and cannot blow the deadline.
  // It applies only once RATIO_SAMPLE of their recent links have been judged —
  // before that there is no denominator and therefore no verdict.
  const ratio = await getRecentJudgedRate(userId, rules.ratioSample, RATIO_POOL).catch(
    () => null
  )
  // Not while a genre passes, for the same reason: the overall rate is dragged
  // down by the genre that is now paused, and the genre that is fine is work.
  if (
    ratio && ratio.judged >= rules.ratioSample && ratio.pct < rules.ratioMinPct && !anyPassing
  ) {
    return { judged, found, skipped, block: true, rule: 'ratio', ratio, genres, rules }
  }
  return { judged, found, skipped, block: false, ratio, genres, rules }
}
