import { headers } from 'next/headers'
import { auth } from './auth'
import { isAdminEmail } from './config'

/**
 * May this request act as the admin?
 *
 * An admin SESSION, as always — or a machine token, for the local tools that
 * have no browser session to offer. The channel scrape is the reason: Instagram
 * serves its profile pages as a JavaScript shell and fills them in afterwards,
 * so listing a profile needs something that executes JavaScript. A serverless
 * function cannot; the scraper on the operator's own machine, driving a
 * signed-in browser, can. For that loop to run unattended it has to be able to
 * ask the dashboard which channels to visit and hand back what it found.
 *
 * TWO TOKENS, matching what each side already grants:
 *
 *   LINKS_EXPORT_TOKEN  read. Already hands out the whole filtered link pool
 *                       (/api/links/clusters), so the channel list is nothing new.
 *   UPLOAD_SECRET       write. Already replaces the entire link pool
 *                       (/api/upload), so staging rows is strictly less.
 *
 * Neither is a privilege the token did not already carry, which is the only
 * reason to reuse them rather than mint a third. A blank env var never matches:
 * an unset secret must not turn into an open door.
 */
export type MachineScope = 'read' | 'write'

function presented(req: Request): string {
  const h = req.headers
  return (
    h.get('x-upload-secret') ||
    h.get('x-links-token') ||
    (h.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    ''
  )
}

/** Constant-time-ish compare. Length leaks, the contents do not. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function hasMachineToken(req: Request, scope: MachineScope): boolean {
  const given = presented(req)
  if (!given) return false
  const write = process.env.UPLOAD_SECRET ?? ''
  const read = process.env.LINKS_EXPORT_TOKEN ?? ''
  // The write secret is accepted for reads too: anything it can do already
  // includes replacing the pool, so refusing it a read would be theatre.
  if (sameSecret(given, write)) return true
  return scope === 'read' && sameSecret(given, read)
}

/**
 * An admin session, or a machine token of at least this scope.
 *
 * `req` is required for the token path — headers() alone cannot see a header a
 * route handler was given.
 */
export async function isAdminRequest(req: Request, scope: MachineScope): Promise<boolean> {
  if (hasMachineToken(req, scope)) return true
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}
