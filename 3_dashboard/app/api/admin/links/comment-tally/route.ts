import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { buildAdminLinks, filterAdminLinks, parseLinkQuery } from '@/lib/adminLinks'
import { getProductCommentTally, getLinksForComment } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Our comments, grouped by what they say, most-carried first.
//
// READS WHAT "EXTRACT COMMENTS" ALREADY WROTE. Every press of that button records
// each of our product comments it finds — the text, the product, the position, the
// likes, the account — in link_product_comment. This adds no scanning and no
// storing: it groups those rows by their text and counts the links.
//
// So the numbers move only when a scan moves them, which is the right coupling:
// this can never claim a comment is on a link that the last scan of that link did
// not find it on.
//
// SCOPED TO THE FILTER when the page sends one, because "how often does this
// comment appear" means something different across a cluster than across the
// whole pool, and the page's filter is what the admin is looking at. With no
// filter it covers every link ever scanned.

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const sp = req.nextUrl.searchParams

  // ── one comment's links, for the row that was expanded ──────────────────
  const one = (sp.get('text') ?? '').trim()
  if (one) {
    const links = await getLinksForComment(one).catch(() => [])
    return NextResponse.json({ ok: true, text: one, links })
  }

  try {
    // Only narrow when the page actually asked to. `scope=all` is how it says
    // "everything", and an empty query means the same.
    let urls: string[] | undefined
    let label = 'every scanned link'
    if (sp.get('scope') !== 'all') {
      const qy = parseLinkQuery(sp)
      const narrowed =
        (qy.clusters?.length ?? 0) > 0 ||
        !!qy.platform ||
        !!qy.product ||
        !!qy.keyword ||
        !!qy.q ||
        !!qy.uploadDate ||
        !!qy.titleFilter ||
        !!qy.mediaFilter
      if (narrowed) {
        const { rows, retirePlatforms } = await buildAdminLinks(qy.product ?? '')
        const filtered = filterAdminLinks(rows, qy, retirePlatforms)
        urls = filtered.map((l) => l.url)
        label = `the ${urls.length.toLocaleString()} filtered link(s)`
        // A filter that matches nothing is not the same as no filter, and must
        // not silently widen to the whole pool.
        if (urls.length === 0) {
          return NextResponse.json({
            ok: true,
            scope: label,
            rows: [],
            distinct: 0,
            hits: 0,
            links: 0,
          })
        }
      }
    }
    const t = await getProductCommentTally({ urls, limit: 1000 })
    return NextResponse.json({ ok: true, scope: label, ...t })
  } catch (e) {
    return NextResponse.json(
      { error: `Could not tally the comments: ${String(e)}` },
      { status: 500 }
    )
  }
}
