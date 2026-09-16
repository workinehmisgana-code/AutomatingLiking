import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { isProduct, VERIFY_VIDEO_URL, VERIFY_GATE_ENABLED } from '@/lib/config'
import { serveCommentForUrl } from '@/lib/serveComment'
import {
  getClickedUrls,
  recordClick,
  recordCleanSessionClick,
  getServeOnlyClean,
  countRecentClicks,
  getEffectivePlatformLimit,
  isUserVerified,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

async function requireUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user?.id ?? null
}

// List the URLs the signed-in user has already clicked.
export async function GET() {
  const userId = await requireUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(userId)
  if (gate) return gate

  if (VERIFY_GATE_ENABLED && !(await isUserVerified(userId).catch(() => false))) {
    return NextResponse.json(
      { error: 'Comment on the verification video first', verifyRequired: true, verifyUrl: VERIFY_VIDEO_URL },
      { status: 403 }
    )
  }

  try {
    const urls = await getClickedUrls(userId)
    return NextResponse.json({ urls })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// Record a click. The link is thereafter hidden from this user.
export async function POST(req: NextRequest) {
  const userId = await requireUserId()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(userId)
  if (gate) return gate

  let servedProduct: string | null = null
  let url = ''
  let searchQuery: string | null = null
  let platform: string | null = null
  try {
    const body = await req.json()
    url = String(body?.url ?? '').trim()
    searchQuery = body?.search_query ? String(body.search_query) : null
    platform = body?.platform ? String(body.platform) : null
    // A `product` here means the page already copied that product's comment
    // itself; otherwise the server picks one fairly for this link below.
    const raw = String(body?.product ?? '').trim()
    servedProduct = isProduct(raw) ? raw : null
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!url) return NextResponse.json({ error: 'Missing url' }, { status: 400 })

  try {
    // Hard cap: at most `limit` links per platform per rolling window (both are
    // admin-configurable per platform; limit <= 0 means unlimited). Skipped
    // entirely when the master switch is OFF (the default) or when this one
    // platform's switch is off — platforms are enforced independently.
    if (platform) {
      const { limit, windowMs, enforced } = await getEffectivePlatformLimit(platform)
      if (enforced && limit > 0) {
        const recent = await countRecentClicks(userId, platform, windowMs)
        if (recent >= limit) {
          return NextResponse.json(
            { error: 'Hourly limit reached for this platform', code: 'RATE_LIMIT' },
            { status: 429 }
          )
        }
      }
    }
    // Server-side fair pick when the client didn't serve one itself. Fairness is
    // per link: the least-served product for THIS url wins (see serveCommentForUrl).
    const served: { product: string | null; comment: string | null } = servedProduct
      ? { product: servedProduct, comment: null }
      : await serveCommentForUrl(url).catch(() => ({ product: null, comment: null }))

    await recordClick(userId, url, searchQuery, platform, served.product, served.comment)
    // While "only links with none of ours" is on the permanent record is
    // ignored when serving, so without this the same link comes back on every
    // fetch of the session. Recorded alongside, never instead: the permanent
    // record still gets its row.
    if (await getServeOnlyClean().catch(() => false)) {
      await recordCleanSessionClick(userId, url).catch(() => {})
    }
    return NextResponse.json({ ok: true, product: served.product, comment: served.comment })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
