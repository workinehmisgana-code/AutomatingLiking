// How the two clusterings are mixed when links are served.
//
// There used to be a clock: five-minute windows, one in four ordered by search
// rank and three by posted-date score, the same for everybody at the same
// instant. That made the ratio a property of WHEN you asked rather than of the
// pool, and it meant every worker in the country was handed the same dimension
// at the same moment.
//
// Now the ratio is a probability. Each link served is drawn from the date
// ordering with `dateShare` percent chance and from the rank ordering with the
// rest, so a feed is a blend in the configured proportion instead of a block of
// one kind. The draw is seeded by the USER, so two people working at the same
// second get different blends — but one person's own feed is stable, which is
// what makes it debuggable and stops a refresh from reshuffling their list.
//
// The percentage is set in the admin dashboard (Links page) and stored in
// app_kv; nothing here reads a clock.

/** Percent of served links drawn from the posted-date ordering. */
export const DEFAULT_DATE_SHARE = 75

/**
 * Read a share out of whatever the admin field or the database gives us.
 *
 * Empty or unreadable means the DEFAULT, never 0. `Number('')` is 0, and 0
 * silently means "never serve a date-clustered link again" — the kind of
 * mistake that looks like a bug in the clustering for a week before anyone
 * connects it to a cleared input box.
 */
export function clampShare(n: unknown): number {
  if (n === null || n === undefined) return DEFAULT_DATE_SHARE
  if (typeof n === 'string' && n.trim() === '') return DEFAULT_DATE_SHARE
  const v = Number(n)
  if (!Number.isFinite(v)) return DEFAULT_DATE_SHARE
  return Math.max(0, Math.min(100, Math.round(v)))
}

/** A 32-bit seed from a user id, so each user gets their own blend. */
export function seedFrom(key: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

/** mulberry32 — small, fast, and the same sequence for the same seed. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Which clustering a single draw picks. Used where only one can be shown. */
export function pickDimension(seed: number, dateShare: number): 'rank' | 'date' {
  return rng(seed)() * 100 < clampShare(dateShare) ? 'date' : 'rank'
}

/**
 * Blend two already-ordered lists into one feed.
 *
 * Both lists are in their own clustering's score order and are left in it — the
 * only random thing is WHICH list the next link comes from. So a link never
 * jumps ahead of a better-scoring link from the same clustering.
 *
 * The two lists overlap heavily (most links have both a rank and a date), so a
 * link already taken from one is skipped in the other. The pointers are walked
 * PAST anything already emitted before each draw rather than after it, or a
 * draw spent on a duplicate would silently count toward the ratio and the
 * realised blend would drift away from the setting.
 */
export function mixOrderings<T extends { url: string }>(
  rankOrder: T[],
  dateOrder: T[],
  dateShare: number,
  seed: number,
  limit = Infinity
): T[] {
  const share = clampShare(dateShare)
  const next = rng(seed)
  const seen = new Set<string>()
  const out: T[] = []
  let i = 0
  let j = 0

  const skipSeen = () => {
    while (i < rankOrder.length && seen.has(rankOrder[i].url)) i++
    while (j < dateOrder.length && seen.has(dateOrder[j].url)) j++
  }

  skipSeen()
  while (out.length < limit && (i < rankOrder.length || j < dateOrder.length)) {
    // When one side is exhausted the other supplies everything — running out of
    // date-clustered links must not end the feed.
    const takeDate =
      j < dateOrder.length && (i >= rankOrder.length || next() * 100 < share)
    const e = takeDate ? dateOrder[j++] : rankOrder[i++]
    seen.add(e.url)
    out.push(e)
    skipSeen()
  }
  return out
}
