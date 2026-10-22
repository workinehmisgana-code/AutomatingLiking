// The admin's master genre switch.
//
// WHY ONE SWITCH. Five admin screens used to choose a genre each, with their own
// local state, so the Links page could be on Website while the home page summed
// humanizer and website clicks together and the comments picker listed every
// product in one flat list. Nothing was wrong on any single screen; the
// dashboard as a whole was answering questions about a mixture. One position,
// read by every screen, means every number on the page is about the same thing.
//
// WHY A COOKIE. Server components render most of the admin, and they cannot
// read browser storage. A cookie arrives with every request, so a server page
// knows the genre before it queries anything — and it lives in the admin's own
// browser, so two admins can work different genres at once without fighting
// over a shared setting.
//
// Kept separate from config.ts because it reads request headers: config is
// imported by browser code too, and next/headers cannot be.

import { cookies } from 'next/headers'
import { ADMIN_GENRE_COOKIE, DEFAULT_GENRE, isGenre, type Genre } from './config'
import { getPoolGenreIndex } from './videos'
import { ensureGenreRegistry } from './genreStore'

export { ADMIN_GENRE_COOKIE }

/**
 * The genre this admin has selected, or the default.
 *
 * Validated rather than trusted: the cookie is the browser's to edit, and a
 * stale value from before a genre was renamed must not leave every query
 * filtering on a genre that no longer exists.
 */
export async function getAdminGenre(): Promise<Genre> {
  // An added genre is only a genre once the registry is applied (cheap when it
  // already is, see lib/genreStore).
  await ensureGenreRegistry().catch(() => {})
  try {
    const v = (await cookies()).get(ADMIN_GENRE_COOKIE)?.value
    return isGenre(v) ? v : DEFAULT_GENRE
  } catch {
    // cookies() throws outside a request (a build-time render, a script).
    return DEFAULT_GENRE
  }
}

/**
 * A test for "is this pool link in the admin's genre", for API routes that
 * work over the whole pool (sweeps, refreshes, lists).
 *
 * Read from the pool's own genre index, so a link's genre is the one it is
 * served under. A URL the pool does not hold (a broken link that has since
 * been removed, a scanned link long gone) counts as the default genre — the
 * genre every pre-genre link belongs to.
 */
export async function adminGenreUrlTest(): Promise<{ genre: Genre; has: (url: string) => boolean }> {
  const [genre, index] = await Promise.all([getAdminGenre(), getPoolGenreIndex()])
  return { genre, has: (url: string) => (index.get(url) ?? DEFAULT_GENRE) === genre }
}
