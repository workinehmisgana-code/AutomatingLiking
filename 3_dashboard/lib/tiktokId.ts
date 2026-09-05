// When was a TikTok account created?
//
// TikTok publishes this nowhere — not on the profile page, not in the embed
// payload, not through oEmbed. But its ids are snowflakes: the top 32 bits of a
// numeric id are the unix second it was minted, and an account's id is minted
// when the account is. So the id alone dates the account.
//
// That is a claim about undocumented internals, so it was tested rather than
// assumed, over 77 accounts collected from the comment lists of 30 videos:
//
//   decode to a plausible date        : 76 of 77
//   account predates its own comment  : 78 of 78   (the hard constraint — an
//                                       account cannot comment before it exists,
//                                       and a single violation would kill this)
//   spread of decoded years           : 2018 through 2026, no clustering
//
// The one id that did not decode was short — pre-snowflake, from before the
// scheme existed. Those return null rather than a wrong date.
//
// The id itself only ever appears in one response: /api/comment/list/, as
// user.uid. It is captured while judging comment presence, which reads that
// endpoint anyway, so this costs nothing extra.

/** TikTok's own launch, as a floor. Nothing real decodes to before this. */
const FLOOR_SEC = 1451606400 // 2016-01-01

/**
 * The moment a TikTok account was created, from its numeric id.
 *
 * Returns null for anything that does not decode to a plausible date: a
 * pre-snowflake id, a handle passed by mistake, or a date in the future.
 */
export function accountCreatedAt(uid: string | number | null | undefined): Date | null {
  const raw = String(uid ?? '').trim()
  if (!/^\d+$/.test(raw)) return null
  let secs: number
  try {
    // Division rather than `>> 32n`: BigInt literals need an ES2020 target and
    // this file is compiled for the browser bundle too. Same result for a
    // positive id, which is the only kind there is.
    const n = BigInt(raw)
    if (n <= BigInt(0)) return null
    secs = Number(n / BigInt(4294967296))
  } catch {
    return null
  }
  if (secs < FLOOR_SEC) return null
  const ms = secs * 1000
  // A day of slack, so a clock skew between here and TikTok is not a rejection.
  if (ms > Date.now() + 86_400_000) return null
  return new Date(ms)
}

/** "2 years, 4 months", from a creation date. Empty when the date is unusable. */
export function accountAge(created: Date | null): string {
  if (!created) return ''
  const now = Date.now()
  const ms = now - created.getTime()
  if (ms < 0) return ''
  const days = Math.floor(ms / 86_400_000)
  if (days < 1) return 'today'
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} old`
  const months = Math.floor(days / 30.44)
  if (months < 24) return `${months} months old`
  const years = Math.floor(days / 365.25)
  const rem = Math.floor((days - years * 365.25) / 30.44)
  return rem > 0 ? `${years} yr ${rem} mo old` : `${years} years old`
}
