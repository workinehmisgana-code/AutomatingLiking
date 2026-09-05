// Instagram (and other platforms) login-wall crawlers from datacenter IPs: the
// page still loads but its title/description is a generic "Login • Instagram" /
// "Create an account or log in…" placeholder rather than the real caption.
// These helpers reject such placeholders so we never show or cache them as a
// title — used both when fetching (titles route) and when reading the cache (db).
// Pages fall back to <title>, which carries a platform suffix — "My clip - YouTube".
// When the page has no real title that leaves only the suffix ("- YouTube"), which
// is worthless as a title and worse as classifier input. Strip it so the real text
// (if any) is what's kept, and so a bare suffix collapses to '' and is rejected below.
const PLATFORM_SUFFIX = /\s*[-–—|•·]\s*(youtube|tiktok|instagram)\s*$/i

export function stripPlatformSuffix(s: string): string {
  let t = s.trim()
  // Twice: "clip - YouTube - YouTube" happens on some mirrored pages.
  for (let i = 0; i < 2; i++) t = t.replace(PLATFORM_SUFFIX, '').trim()
  return t
}

export function isGenericTitle(s: string): boolean {
  const t = stripPlatformSuffix(s).toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return true
  if (t === 'instagram' || t === 'youtube' || t === 'tiktok') return true
  if (t.includes('login') && t.includes('instagram')) return true // "Login • Instagram"
  if (t.startsWith('log in') || t.startsWith('login')) return true
  if (t.startsWith('create an account or log in')) return true
  if (t.startsWith('see photos and videos from')) return true // generic profile card
  return false
}
