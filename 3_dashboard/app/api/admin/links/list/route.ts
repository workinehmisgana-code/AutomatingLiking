import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  buildAdminLinks,
  filterAdminLinks,
  parseLinkQuery,
  sortAdminLinks,
  type LinkQuery,
} from '@/lib/adminLinks'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// How many rows one request may return. The page renders a window; the totals
// and the filtering are computed over the whole pool regardless.
const MAX_ROWS = 1000

// The page's filters, parsed by the one shared parser, plus the paging this
// endpoint alone needs. Every other endpoint that scopes work to "the links
// currently filtered" reads the same query the same way.
function parseQuery(sp: URLSearchParams): LinkQuery {
  return {
    ...parseLinkQuery(sp),
    offset: Math.max(0, Number(sp.get('offset')) || 0),
    limit: Math.min(MAX_ROWS, Math.max(1, Number(sp.get('limit')) || MAX_ROWS)),
  }
}

// GET — one window of the admin links list, plus pool-wide counts and the
// filter option lists. `urls=1` instead returns EVERY matching URL and no rows:
// the bulk Delete/Block actions operate on the whole filtered set, not just the
// window, so they need the full list without paying for the row payload.
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const qy = parseQuery(req.nextUrl.searchParams)
    const built = await buildAdminLinks(qy.product ?? '')
    const matched = sortAdminLinks(filterAdminLinks(built.rows, qy, built.retirePlatforms), qy)

    if (req.nextUrl.searchParams.get('urls') === '1') {
      return NextResponse.json({ urls: matched.map((l) => l.url), matched: matched.length })
    }

    const offset = Math.min(qy.offset ?? 0, Math.max(0, matched.length - 1))
    return NextResponse.json({
      rows: matched.slice(offset, offset + (qy.limit ?? MAX_ROWS)),
      matched: matched.length,
      offset,
      limit: qy.limit ?? MAX_ROWS,
      counts: built.counts,
      keywords: built.keywords,
      uploadDays: built.uploadDays,
      products: built.products,
      retirePlatforms: built.retirePlatforms,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
