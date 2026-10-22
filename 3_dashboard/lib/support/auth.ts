import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'

/**
 * Every support-desk route is admin-only.
 *
 * The standalone Support Desk had no sign-in at all: it ran on one PC and was
 * reachable only from it. Here the same routes refund money, cancel
 * subscriptions, delete customer accounts and send mail as each product, from
 * a public URL — so each handler starts with this and refuses anyone else.
 *
 * Returns a 403 response to send back, or null when the caller is an admin.
 */
export async function supportGuard(): Promise<NextResponse | null> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (isAdminEmail(session?.user?.email)) return null
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}
