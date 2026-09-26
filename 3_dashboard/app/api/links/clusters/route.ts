import { NextResponse, type NextRequest } from 'next/server'
import {
  buildAdminLinks,
  filterAdminLinks,
  sortAdminLinks,
  type LinkQuery,
  type ClusterBy,
} from '@/lib/adminLinks'
import { getActiveCommentProducts, getUrlsWithProductComments } from '@/lib/db'
import { PRODUCTS } from '@/lib/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Links for one cluster selection, for tools outside the dashboard.
//
// Protected by the shared LINKS_EXPORT_TOKEN rather than a login, because the
// callers are scripts that cannot run Google OAuth — the same arrangement as
// /api/links/export.
//
// It calls buildAdminLinks + filterAdminLinks, which is the code path the admin
// UI itself uses. That matters: clusters are RELATIVE, assigned by splitting the
// sorted pool per platform, so they exist nowhere in the database and cannot be
// recomputed by a script without drifting from what you see on screen. Asking
// the dashboard is the only way for the two to agree.
//
//   GET /api/links/clusters?token=…&clusterBy=rank&clusters=1,2
//
// Params mirror the admin list: clusterBy (rank|date|combined), clusters,
// platform, product, category, keyword, minRatio/maxRatio, q. `blocked` links
// are excluded, as they are in the UI.
//
// The response also carries the ACTIVE comment products, so a caller matching
// comments against "our products" uses the set the admin has switched on rather
// than a list hardcoded on its own side.
export async function GET(req: NextRequest) {
  const token = process.env.LINKS_EXPORT_TOKEN
  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    req.nextUrl.searchParams.get('token') ||
    ''
  if (!token || provided !== token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const num = (v: string | null) => {
    if (v == null || v.trim() === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const clusterBy = ((sp.get('clusterBy') || 'rank') as ClusterBy)
  const clusters = (sp.get('clusters') ?? '')
    .split(',')
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)

  const qy: LinkQuery = {
    platform: sp.get('platform') ?? 'tiktok',
    product: sp.get('product') ?? '',
    keyword: sp.get('keyword') ?? '',
    category: sp.get('category') ?? '',
    uploadDate: sp.get('uploadDate') ?? '',
    mediaFilter: (sp.get('media') || '') as LinkQuery['mediaFilter'],
    clusters,
    clusterBy,
    minClicks: num(sp.get('minClicks')),
    maxClicks: num(sp.get('maxClicks')),
    minRatio: num(sp.get('minRatio')),
    maxRatio: num(sp.get('maxRatio')),
    q: sp.get('q') ?? '',
    sortDir: 'desc',
  }

  try {
    const built = await buildAdminLinks(qy.product ?? '')
    let matched = sortAdminLinks(filterAdminLinks(built.rows, qy, built.retirePlatforms), qy)

    // withoutOurs=1 — only links that carry NONE of our comments.
    //
    // For a run whose job is to comment on those. Without it the liker pulls
    // the whole list and opens every video to find out, which is one page load
    // each to discard the ~80% that already have one of ours.
    //
    // It drops links KNOWN to carry one — a link nobody has scanned is not
    // known to be clean, and stays in. That is the honest direction to be wrong
    // in: the liker re-reads each video's own comments before writing anything,
    // so a link that slips through is skipped there rather than commented on
    // twice. This only saves the page loads it can prove are wasted.
    let droppedWithOurs = 0
    if (sp.get('withoutOurs') === '1') {
      const withOurs = new Set(
        (await getUrlsWithProductComments().catch(() => [] as string[])).map((u) => u)
      )
      const before = matched.length
      matched = matched.filter((l) => !withOurs.has(l.url))
      droppedWithOurs = before - matched.length
    }
    const limit = Math.max(1, Math.min(20_000, Number(sp.get('limit')) || 5_000))
    // Active by default. `allProducts=1` returns every product including the
    // deactivated ones, for a caller that wants to like comments naming a
    // product the app no longer serves — those comments are still out there.
    const active = await getActiveCommentProducts().catch(() => [] as string[])
    const products = sp.get('allProducts') === '1' ? [...PRODUCTS] : active

    return NextResponse.json({
      ok: true,
      clusterBy,
      clusters,
      matched: matched.length,
      // How many the filter removed, so a caller can say why its list is
      // shorter than the cluster it asked for.
      droppedWithOurs,
      returned: Math.min(matched.length, limit),
      products,
      // Always both, so a caller can choose without asking twice.
      activeProducts: active,
      allProducts: [...PRODUCTS],
      // Cluster and category travel with each link so a caller can group its own
      // reporting without asking again.
      links: matched.slice(0, limit).map((l) => ({
        url: l.url,
        cluster:
          clusterBy === 'rank'
            ? l.rankCluster
            : clusterBy === 'date'
              ? l.dateCluster
              : l.combinedCluster,
        category: l.category,
        clicks: l.clicks,
      })),
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
