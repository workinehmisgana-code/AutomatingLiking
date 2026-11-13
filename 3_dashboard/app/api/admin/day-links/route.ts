import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, isGenre, productsInGenre } from '@/lib/config'
import { getDayLinks, getDayOwnLinks } from '@/lib/db'
import { getAdminGenreScope } from '@/lib/adminGenre'

export const dynamic = 'force-dynamic'

// GET /api/admin/day-links?day=YYYY-MM-DD&product=<p> — the links clicked for
// one product on one day (the daily-clicks table's cells). Admin only.
//
// &own=1 — only the TikTok links carrying the served worker's own comment (the
// "with the worker's own comment" rows). Without a product it is the TikTok
// platform row: every product in the admin's genre scope.
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const day = (req.nextUrl.searchParams.get('day') || '').trim()
  const product = (req.nextUrl.searchParams.get('product') || '').trim()
  const own = req.nextUrl.searchParams.get('own') === '1'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (!product && !own)) {
    return NextResponse.json({ error: 'Give a day (YYYY-MM-DD) and a product.' }, { status: 400 })
  }
  try {
    if (own) {
      // The same genre cut the dashboard's counts were made with.
      const scope = await getAdminGenreScope().catch(() => '')
      const products = scope && isGenre(scope) ? productsInGenre(scope) : null
      return NextResponse.json({ links: await getDayOwnLinks(day, product || null, products) })
    }
    return NextResponse.json({ links: await getDayLinks(day, product) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
