// Referral usernames: what they look like, and what counts as the same one.
//
// The username is typed by somebody else, from memory or off a screenshot, at
// the one moment that can never be corrected — registration. Everything here
// exists to make that typing forgiving without making two different people's
// codes collide:
//
//   * case never matters, and neither does a leading @;
//   * anything that is not a letter or a digit is dropped, so "abebe_k",
//     "abebe.k" and "Abebe K" all reach the same code;
//   * a code is derived from the person's own name, so it is something they can
//     say out loud rather than a random string nobody can pass on correctly.
//
// The cost of that forgiveness is that two people called Abebe Kebede cannot
// both be `abebek` — the second becomes `abebek2`. That is the one case where a
// referral can land on the wrong person, so the dashboard shows each user their
// own exact code to copy rather than letting them guess it.

/** Longest a code may be. Long enough for a full name, short enough to type. */
export const MAX_CODE = 20

/** Shortest a code may be, so single initials do not become everyone's code. */
export const MIN_CODE = 3

/**
 * The comparable form of a referral username.
 *
 * Applied to BOTH sides — the stored code and whatever a new user typed — so
 * that "@Abebe.K " and "abebek" are the same code. Returns '' when nothing
 * usable is left, which callers must treat as "no code entered".
 */
export function normalizeReferralCode(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, MAX_CODE)
}

/**
 * A code to offer a new user, from their name, falling back to their email.
 *
 * Not unique on its own — the caller adds a numeric suffix if it is taken. The
 * fallbacks matter more than they look: a user whose name is written entirely
 * in Amharic script normalises to '', and without the email fallback every one
 * of them would be competing for the same code.
 */
export function referralCodeFrom(name: unknown, email: unknown): string {
  const fromName = normalizeReferralCode(name)
  if (fromName.length >= MIN_CODE) return fromName
  const fromEmail = normalizeReferralCode(String(email ?? '').split('@')[0])
  if (fromEmail.length >= MIN_CODE) return fromEmail
  // Neither was usable. 'user' plus a suffix is honest about that; a random
  // string would be worse, because the whole point is that it can be passed on.
  return 'user'
}

/**
 * The nth candidate for a base code: the base, then base2, base3, …
 *
 * The suffix is appended inside MAX_CODE rather than past it, or a long name
 * would produce a code the column could not distinguish from its neighbours.
 */
export function candidateCode(base: string, n: number): string {
  if (n <= 1) return base
  const suffix = String(n)
  return base.slice(0, Math.max(MIN_CODE, MAX_CODE - suffix.length)) + suffix
}
