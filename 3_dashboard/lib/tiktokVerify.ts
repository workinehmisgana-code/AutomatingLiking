// Proving a worker owns the TikTok account they registered, and that it is old
// enough to be worth anything.
//
// A brand-new account is the cheapest thing in this business: somebody signs
// up, makes an account that morning, and its comments are weightless — TikTok
// trusts them least, and they are the first to be filtered. So before anyone
// starts, they comment their name on one video we control, and that single
// comment answers both questions at once:
//
//   do they own the account?   the comment came FROM it, which nobody else can
//                              arrange
//   how old is the account?    the comment list is the only place TikTok ever
//                              exposes a numeric user id, and that id is a
//                              snowflake (see lib/tiktokId)
//
// THE HANDLE IS THE PROOF, AND THE ONLY PROOF. A comment posted from the
// account they registered could not have been posted by anybody else, which is
// the whole question. We still ASK them to comment their name, because that is
// what makes the comment legible to a human scrolling the video — but we do not
// require it.
//
// It was required at first, and that was wrong twice over. Names are not unique
// or owned, so a name match proves nothing the handle match has not already
// proved; and insisting on it turned honest comments into rejections — someone
// who wrote a greeting, or their first name spelled differently, was told to go
// back and edit a comment that was already perfectly good evidence.

import { fetchComments, type VideoComment } from './linkStats'
import { accountCreatedAt } from './tiktokId'
import { VERIFY_MIN_AGE_DAYS } from './config'

// The default floor. Defined in config beside the other verification settings
// so db.ts can reach it without importing this file, and re-exported here
// because this is where callers of the check already look.
export { VERIFY_MIN_AGE_DAYS } from './config'

/**
 * How deep to read the comment list.
 *
 * 50 per page. The list is RANKED, not chronological — measured on a video with
 * 3,283 comments: 78% of consecutive pairs were newest-first, so it leans
 * recent but promotes some older ones — and we could read 296 of them. A check
 * run straight after the worker comments therefore nearly always finds it,
 * while one run weeks later on a busy video might not.
 *
 * That is why "not found" is its own answer and never a rejection, and why the
 * video is a setting that can be rotated when it gets busy.
 */
export const VERIFY_PAGES = 8

export type VerifyStatus =
  /** Found, and the account is old enough. */
  | 'ok'
  /** Found, but the account is younger than the floor. */
  | 'too_new'
  /** Not in what we could read. Try again; never a rejection. */
  | 'not_found'
  /** They have not registered a TikTok profile yet. */
  | 'no_handle'
  /** TikTok would not give us the video's comments at all. */
  | 'unreadable'

export interface VerifyResult {
  status: VerifyStatus
  /** The handle we looked for, lowercased, without the '@'. */
  handle: string
  /** Their numeric account id, when the comment was found. */
  uid: string | null
  /** When the account was made, when the id decodes. */
  createdAt: Date | null
  /** Whole days old, or null when the id does not decode. */
  ageDays: number | null
  /** What they actually commented, for an admin to read. */
  text: string
  /** How much of the comment list we saw, so "not found" can be judged. */
  read: number
  total: number | null
  complete: boolean
  /** One line for the worker. */
  message: string
}

/** The '@handle' out of a profile URL, or out of a bare handle. */
export function handleOf(profile: string | null | undefined): string {
  const raw = String(profile ?? '').trim()
  if (!raw) return ''
  const m = raw.match(/tiktok\.com\/@([^/?#\s]+)/i)
  return (m ? m[1] : raw.replace(/^@/, '')).trim().toLowerCase()
}

/**
 * The decision, given a comment that is theirs. Separate so it can be tested
 * without the network.
 *
 * By the time this is called, ownership is already settled — the comment came
 * from their handle. The only question left is how old the account is.
 */
export function judge(
  comment: VideoComment,
  now: Date = new Date(),
  minAgeDays: number = VERIFY_MIN_AGE_DAYS
): Pick<VerifyResult, 'status' | 'uid' | 'createdAt' | 'ageDays' | 'message'> {
  const createdAt = accountCreatedAt(comment.uid)
  // A pre-snowflake id belongs to an OLD account — the scheme postdates them.
  // Treating "does not decode" as "too new" would reject exactly the accounts
  // this rule exists to welcome.
  const ageDays =
    createdAt === null
      ? null
      : Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000)

  if (ageDays !== null && ageDays < minAgeDays) {
    const months = Math.floor(ageDays / 30)
    return {
      status: 'too_new',
      uid: comment.uid,
      createdAt,
      ageDays,
      message:
        `This TikTok account was created ${ageDays} day(s) ago` +
        `${months >= 1 ? ` (about ${months} month${months === 1 ? '' : 's'})` : ''}. ` +
        `Accounts must be at least ${minAgeDays} day${minAgeDays === 1 ? '' : 's'} old, so ` +
        'this one cannot be used. Please register an older TikTok account.',
    }
  }
  return {
    status: 'ok',
    uid: comment.uid,
    createdAt,
    ageDays,
    message: 'Your TikTok account is verified. You can start working.',
  }
}

/**
 * Run the whole check for one worker.
 *
 * Never throws: every failure is a status with something to tell the worker.
 */
export async function runTiktokCheck(opts: {
  profile: string | null | undefined
  videoUrl: string
  now?: Date
  /** The live floor. Omitted, the compiled default applies. */
  minAgeDays?: number
}): Promise<VerifyResult> {
  const handle = handleOf(opts.profile)
  const base = {
    handle,
    uid: null,
    createdAt: null,
    ageDays: null,
    text: '',
    read: 0,
    total: null as number | null,
    complete: false,
  }
  if (!handle) {
    return {
      ...base,
      status: 'no_handle',
      message:
        'Add your TikTok profile link to your account first, then comment on the video.',
    }
  }

  const read = await fetchComments(opts.videoUrl, VERIFY_PAGES).catch(() => null)
  if (!read || read.unresolved) {
    return {
      ...base,
      status: 'unreadable',
      message: 'We could not read the video just now. Please try again in a minute.',
    }
  }

  const mine = read.comments.filter((c) => c.username.toLowerCase() === handle)
  const seen = { read: read.comments.length, total: read.total, complete: read.complete }
  if (mine.length === 0) {
    return {
      ...base,
      ...seen,
      status: 'not_found',
      message:
        `We could not find a comment from @${handle} on the video yet. ` +
        'Comment your name on it, wait a moment, then check again.',
    }
  }

  // Their newest comment. Any of them settles ownership equally, but the newest
  // is the one they will have just posted, so it is the one to quote back.
  const pick = mine.reduce((best, c) =>
    (Date.parse(c.postedAt ?? '') || 0) >= (Date.parse(best.postedAt ?? '') || 0) ? c : best
  )
  return {
    ...base,
    ...seen,
    ...judge(pick, opts.now, opts.minAgeDays ?? VERIFY_MIN_AGE_DAYS),
    text: pick.text,
  }
}
