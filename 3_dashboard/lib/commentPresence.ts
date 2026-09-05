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
  getClickedOnDay,
  getJudgedLinks,
  saveJudgedLinks,
  getRecentClickedLinks,
  getJudgedVerdicts,
  recordTiktokAccount,
} from './db'

/**
 * Comment reads in flight at once.
 *
 * TikTok's comment endpoint is slow and erratic (1–5s, occasionally ~19), and
 * concurrency is what makes reading a whole day feasible: measured serially it
 * managed 0.2 links/sec, against 0.7/sec with several in flight. Kept modest so
 * a sweep does not look like an attack.
 */
const CONCURRENCY = 4

/**
 * Most links judged for one user on one day.
 *
 * A heavy day runs to 160 links and every one costs a TikTok read, so the tail
 * of a big day buys precision nobody needs: 100 links already pins a percentage
 * to within a point or two.
 */
export const MAX_LINKS_PER_DAY = 100

/**
 * Cut a day down to MAX_LINKS_PER_DAY, spread EVENLY across the list.
 *
 * Not the first 100. The list is newest-first, so taking a prefix would score
 * everyone on their evening only — and someone who commented all morning and
 * then just clicked through would look perfect. An even stride covers the whole
 * day.
 *
 * Deterministic on purpose: the resume ledger only works if every pass picks
 * the same links, so this must never be random.
 */
export function capDayLinks(all: string[]): string[] {
  if (all.length <= MAX_LINKS_PER_DAY) return all
  const stride = all.length / MAX_LINKS_PER_DAY
  const out: string[] = []
  for (let i = 0; i < MAX_LINKS_PER_DAY; i++) out.push(all[Math.floor(i * stride)])
  return out
}

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
  const all = capDayLinks(opened)

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

/** Judged links required before a no-comments verdict may block anyone. */
export const BLOCK_SAMPLE = 50

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
export const MIN_BLOCK_SAMPLE = 20
export const MAX_BLOCK_SAMPLE = 80

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
  if (n === null || n === undefined) return BLOCK_SAMPLE
  if (typeof n === 'string' && n.trim() === '') return BLOCK_SAMPLE
  const v = Number(n)
  if (!Number.isFinite(v)) {
    // Infinity is a coherent request — "as high as it goes". Anything else
    // unreadable is a mistake and falls back.
    return v === Infinity ? MAX_BLOCK_SAMPLE : BLOCK_SAMPLE
  }
  return Math.max(MIN_BLOCK_SAMPLE, Math.min(MAX_BLOCK_SAMPLE, Math.round(v)))
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
  /** Judged links required before a block. Chosen per sweep by the admin;
   *  defaults to BLOCK_SAMPLE so the cron and an unmodified caller agree. */
  sample: number = BLOCK_SAMPLE
): Promise<BlockVerdict> {
  const empty: BlockVerdict = { judged: 0, found: 0, skipped: 0, block: false }
  const username = handleFromProfile(tiktokUrl)
  if (!username) return empty

  // Newest first, across days, so a short day is topped up from earlier ones.
  // Deliberately more than BLOCK_SAMPLE: skipped links have to be replaced by
  // older ones, not merely subtracted from the total.
  const recent = await getRecentClickedLinks(userId, candidatePool(sample)).catch(() => [])
  if (recent.length < sample) return empty

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
  while (found === 0 && judged < sample && i < pending.length) {
    if (Date.now() >= deadline) break
    // `recent` is ordered by click time, so one day's links are contiguous.
    const day = pending[i].day
    let j = i
    while (j < pending.length && pending[j].day === day) j++
    const need = sample - judged
    const slice = pending.slice(i, Math.min(j, i + need))
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

  return { judged, found, skipped, block: judged >= sample && found === 0 }
}
