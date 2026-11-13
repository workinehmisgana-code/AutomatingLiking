import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getUserPlatformLinks } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/admin/user-links?user=<id>&platform=reddit — the links one worker
// clicked on one platform since their reset (the user card's counts). Admin only.
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const user = (req.nextUrl.searchParams.get('user') || '').trim()
  const platform = (req.nextUrl.searchParams.get('platform') || '').trim()
  if (!user || !/^[a-z_]+$/.test(platform)) {
    return NextResponse.json({ error: 'Give a user and a platform.' }, { status: 400 })
  }
  try {
    return NextResponse.json({ links: await getUserPlatformLinks(user, platform) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
