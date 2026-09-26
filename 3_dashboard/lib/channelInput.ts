// Reading a channel out of whatever somebody pastes.
//
// Its own file rather than the route's, because a Next route module may only
// export the HTTP handlers and a short list of config names — anything else
// fails the build. That is a real constraint worth respecting rather than
// working around: this is a pure function with no request in it, and it is
// worth testing without one.

export const CHANNEL_SITES = ['tiktok', 'instagram', 'youtube'] as const
export type ChannelSite = (typeof CHANNEL_SITES)[number]

/** Which handles each site actually allows. YouTube alone permits a hyphen. */
export const HANDLE_RE: Record<ChannelSite, RegExp> = {
  tiktok: /^[A-Za-z0-9._]{1,24}$/,
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  youtube: /^[A-Za-z0-9._-]{1,30}$/,
}

/**
 * instagram.com/<handle>/ and instagram.com/p/<code>/ have the same shape.
 *
 * Without this list, pasting a post link would register a channel called "p" —
 * and then the scraper would be sent to fetch it.
 */
const IG_RESERVED = /^(p|reel|reels|explore|stories|tv|accounts|direct)$/i

export interface ParsedChannel {
  site: ChannelSite | null
  handle: string
}

/**
 * Read a channel out of a profile link, or out of a bare handle.
 *
 * A profile URL is what people actually have to hand — it is what the address
 * bar holds and what gets sent in a message — and it NAMES ITS OWN SITE, so
 * nothing has to be chosen. A bare handle does not, and `site` comes back null:
 * the caller must be told to pick one rather than have one guessed, because 98
 * of our handles exist on more than one site and guessing wrong sends the
 * scraper to a stranger.
 */
export function parseChannelInput(raw: string): ParsedChannel {
  const s = String(raw ?? '').trim()
  if (!s) return { site: null, handle: '' }

  const url = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  const tt = url.match(/^(?:m\.|vm\.)?tiktok\.com\/@([^/?#\s]+)/i)
  if (tt) return { site: 'tiktok', handle: tt[1].toLowerCase() }
  const yt = url.match(/^(?:m\.)?youtube\.com\/@([^/?#\s]+)/i)
  if (yt) return { site: 'youtube', handle: yt[1].toLowerCase() }
  const ig = url.match(/^instagram\.com\/([^/?#\s]+)/i)
  if (ig && !IG_RESERVED.test(ig[1])) return { site: 'instagram', handle: ig[1].toLowerCase() }

  // Not a URL we recognise. If it still looks like one, say so rather than
  // registering a channel named "instagram.com".
  if (/[/.]/.test(s) && !/^@?[A-Za-z0-9._-]+$/.test(s)) return { site: null, handle: '' }

  return { site: null, handle: s.replace(/^@+/, '').toLowerCase() }
}
