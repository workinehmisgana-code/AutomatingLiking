import { getAppState, setAppState } from './db'

// The Comment Tester app's pick list: comments the admin writes for TESTING,
// copied by hand from the tester's 💬 list. Kept apart from every product's
// comment bank on purpose — nothing here is ever served to a worker, and
// nothing a worker is served ever shows up here.
//
// One list for the tester, not one per genre: the tester is a single device the
// owner uses to see whether a comment survives, and which genre the video is
// about is already decided by what they paste.

const KEY = 'tester_comments'
export const TESTER_COMMENTS_MAX = 200
export const TESTER_COMMENT_MAX_CHARS = 2000

/** Trim, drop blanks and duplicates, cap the count and each length. */
export function cleanTesterComments(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    const c = String(raw ?? '').trim().slice(0, TESTER_COMMENT_MAX_CHARS)
    if (!c || seen.has(c)) continue
    seen.add(c)
    out.push(c)
    if (out.length >= TESTER_COMMENTS_MAX) break
  }
  return out
}

export async function getTesterComments(): Promise<string[]> {
  const v = await getAppState(KEY).catch(() => null)
  if (!v) return []
  try {
    return cleanTesterComments(JSON.parse(v))
  } catch {
    return []
  }
}

export async function setTesterComments(list: unknown): Promise<string[]> {
  const clean = cleanTesterComments(list)
  await setAppState(KEY, JSON.stringify(clean))
  return clean
}
