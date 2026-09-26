import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { channelCommentYield } from '@/lib/commentYield'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Channels ranked by how little of our product comment survives per click.
 *
 * GET ?minClicks=25
 *
 * Loaded on demand rather than with the page: it reads every clicked link, every
 * comment scan and videos.json, and most visits to the Links page never ask for
 * it.
 */
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    // Clamped, not trusted. A floor of zero would fill the table with channels
    // sitting at one click, which is not a ratio; a huge one empties it. Both
    // read as "the feature is broken".
    const raw = Number(req.nextUrl.searchParams.get('minClicks'))
    const minClicks = Number.isFinite(raw) ? Math.max(1, Math.min(1000, Math.round(raw))) : 25
    const report = await channelCommentYield(minClicks)
    return NextResponse.json(report)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
