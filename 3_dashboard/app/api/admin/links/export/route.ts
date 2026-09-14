import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, RANK_CLUSTER_COUNT, DATE_CLUSTER_COUNT, retireThreshold } from '@/lib/config'
import { loadVideosJson } from '@/lib/videos'
import { getClickCountsByProductAndUrl, getBlockedUrls, getEffectivePlatformLimits } from '@/lib/db'
import { parsePostedDate } from '@/lib/cluster'

export const dynamic = 'force-dynamic'

const COLUMNS = [
  'platform',
  'rank_cluster',
  'date_cluster',
  'combined_cluster',
  'url',
  'search_query',
  'search_rank',
  'like_count',
  'posted_date',
  'author',
  'clicked_by',
  'retire_at',
  'scraped_at',
] as const

const NUMERIC_COLUMNS = new Set([
  'like_count',
  'search_rank',
  'rank_cluster',
  'date_cluster',
  'combined_cluster',
  'clicked_by',
  'retire_at',
])

const PLATFORM_ORDER = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram', 'unknown']

type Row = Record<string, unknown>

function cell(v: Row, key: string): string {
  return String(v[key] ?? '')
}

// Assign each link its cluster within its platform for BOTH the "Search rank"
// (RANK_CLUSTER_COUNT) and "Posted date" (DATE_CLUSTER_COUNT) dimensions —
// mirroring the user dashboard and the admin links list.
function assignClusters(rows: Row[]): void {
  const byPlatform = new Map<string, Row[]>()
  for (const r of rows) {
    const p = String(r.platform ?? 'unknown')
    const bucket = byPlatform.get(p) ?? []
    if (!byPlatform.has(p)) byPlatform.set(p, bucket)
    bucket.push(r)
  }
  const rankKey = (r: Row) => {
    const n = Number(r.search_rank ?? 0)
    return n > 0 ? n : Number.MAX_SAFE_INTEGER
  }
  // Composite posted-date score when present (see lib/dateScore.ts), plain
  // recency otherwise — so an export matches the clusters users are served.
  //
  // All-or-nothing, as in lib/adminLinks.ts and clusterAndOrder: a 0–1 score and
  // an epoch-ms date must never share one sort, or an unscored link would sort
  // ahead of the whole pool.
  const scoreOf = (r: Row) => {
    const v = (r as { date_score?: unknown }).date_score
    return typeof v === 'number' ? v : null
  }
  const anyScored = rows.some((r) => scoreOf(r) !== null)
  const dateKey = (r: Row) => {
    const v = scoreOf(r)
    // Finite, not Infinity: see lib/adminLinks.ts — Infinity - Infinity is NaN.
    if (anyScored) return v !== null ? -v : Number.MAX_SAFE_INTEGER
    return -(parsePostedDate(String(r.posted_date ?? ''), String(r.scraped_at ?? '')) ?? Number.NEGATIVE_INFINITY)
  }

  const bucketize = (list: Row[], key: (r: Row) => number, field: string, count: number) => {
    const s = [...list].sort((a, b) => key(a) - key(b))
    const n = Math.max(1, Math.min(count, s.length))
    let start = 0
    for (let i = 0; i < n; i++) {
      const size = Math.floor((s.length - start) / (n - i))
      for (let j = start; j < start + size; j++) s[j][field] = i + 1
      start += size
    }
  }
  for (const list of Array.from(byPlatform.values())) {
    // date_only links (merged verify-links) have no rank — exclude from rank clusters.
    // Search rank → RANK_CLUSTER_COUNT clusters, posted date → DATE_CLUSTER_COUNT.
    bucketize(list.filter((r) => !r.date_only), rankKey, 'rank_cluster', RANK_CLUSTER_COUNT)
    bucketize(list, dateKey, 'date_cluster', DATE_CLUSTER_COUNT)
  }
  // Combined ("union") cluster = min of the two (date_only links use date only).
  for (const r of rows) {
    r.combined_cluster = r.date_only
      ? Number(r.date_cluster ?? 0)
      : Math.min(Number(r.rank_cluster ?? 0), Number(r.date_cluster ?? 0))
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────
function csvEscape(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows: Row[]): string {
  const lines = [COLUMNS.join(',')]
  for (const r of rows) lines.push(COLUMNS.map((c) => csvEscape(cell(r, c))).join(','))
  return '﻿' + lines.join('\r\n') // BOM so Excel reads UTF-8 correctly
}

// ── Excel (SpreadsheetML 2003 — opens natively in Excel, one sheet per platform)
// Control chars XML rejects (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F). Built from a
// plain-ASCII string so no literal control bytes live in this source file.
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]', 'g')

function xmlEscape(s: string): string {
  return s
    .replace(CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function sheet(name: string, rows: Row[]): string {
  const header =
    '<Row>' + COLUMNS.map((c) => `<Cell><Data ss:Type="String">${c}</Data></Cell>`).join('') + '</Row>'
  const body = rows
    .map((r) => {
      const cells = COLUMNS.map((c) => {
        const raw = cell(r, c)
        const isNum = NUMERIC_COLUMNS.has(c) && raw !== '' && !isNaN(Number(raw))
        return isNum
          ? `<Cell><Data ss:Type="Number">${Number(raw)}</Data></Cell>`
          : `<Cell><Data ss:Type="String">${xmlEscape(raw)}</Data></Cell>`
      }).join('')
      return `<Row>${cells}</Row>`
    })
    .join('')
  return `<Worksheet ss:Name="${xmlEscape(name).slice(0, 31)}"><Table>${header}${body}</Table></Worksheet>`
}

function toExcel(groups: { name: string; rows: Row[] }[]): string {
  const sheets = groups.map((g) => sheet(g.name, g.rows)).join('')
  return (
    '<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ' +
    'xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    sheets +
    '</Workbook>'
  )
}

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  const format = req.nextUrl.searchParams.get('format') === 'xls' ? 'xls' : 'csv'
  const platform = req.nextUrl.searchParams.get('platform') || '' // '' = all platforms
  const product = req.nextUrl.searchParams.get('product') || '' // '' = all products (max)
  const retiredOnly = req.nextUrl.searchParams.get('retired') === '1'
  // Exact match on the keyword a link was scraped under, mirroring the list's
  // dropdown. Without this the export ignored the filter on screen and quietly
  // wrote the whole pool.
  const keyword = req.nextUrl.searchParams.get('keyword') || ''

  const [all, clicksByProduct, blockedUrls, effective] = await Promise.all([
    loadVideosJson().then((v) => v as unknown as Row[]),
    getClickCountsByProductAndUrl().catch(() => ({}) as Record<string, Record<string, number>>),
    getBlockedUrls().catch(() => [] as string[]),
    getEffectivePlatformLimits().catch(() => ({ retirePlatforms: new Set<string>() })),
  ])
  const blockedSet = new Set(blockedUrls)
  const productKeys = Object.keys(clicksByProduct)
  // Clicks for a URL, scoped to the selected product (or the leading product's
  // count when exporting all products) — retirement is counted per product.
  const clicksOf = (url: string): number => {
    if (product) return clicksByProduct[product]?.[url] ?? 0
    let m = 0
    for (const p of productKeys) {
      const c = clicksByProduct[p]?.[url] ?? 0
      if (c > m) m = c
    }
    return m
  }
  // Annotate + cluster over the full pool first, then apply platform/retired
  // filters (so cluster numbers stay correct regardless of the platform filter).
  const httpAll: Row[] = all
    // Blocked links are never exported (mirrors the admin list, which hides them).
    .filter((v) => String(v.url ?? '').startsWith('http') && !blockedSet.has(String(v.url)))
    .map((v) => {
      const clicked_by = clicksOf(String(v.url))
      const retire_at = retireThreshold(String(v.platform ?? ''), Number(v.like_count ?? 0))
      return { ...v, clicked_by, retire_at }
    })
  assignClusters(httpAll)
  // Retirement applies only on platforms where it is switched on; a row on any
  // other platform never counts as retired → a "retired only" export is empty
  // when retirement is off everywhere.
  const rowIsRetired = (v: Row) =>
    effective.retirePlatforms.has(String(v.platform ?? '')) &&
    Number(v.clicked_by) >= Number(v.retire_at)
  const rows: Row[] = httpAll.filter(
    (v) =>
      (!platform || String(v.platform ?? '') === platform) &&
      (!keyword || String(v.search_query ?? '') === keyword) &&
      (!retiredOnly || rowIsRetired(v))
  )

  const date = new Date().toISOString().slice(0, 10)
  const scope =
    (retiredOnly ? 'retired_' : '') +
    (product ? `${product.replace(/[^a-z0-9]/gi, '')}_` : '') +
    (keyword ? `${keyword.replace(/[^a-z0-9]+/gi, '-')}_` : '') +
    (platform || 'all')

  if (format === 'xls') {
    // One worksheet per platform (or a single sheet when a platform is selected).
    let groups: { name: string; rows: Row[] }[]
    if (platform) {
      groups = [{ name: platform, rows }]
    } else {
      const byPlat = new Map<string, Row[]>()
      for (const r of rows) {
        const p = String(r.platform ?? 'unknown')
        const bucket = byPlat.get(p) ?? []
        if (!byPlat.has(p)) byPlat.set(p, bucket)
        bucket.push(r)
      }
      const ordered = [
        ...PLATFORM_ORDER.filter((p) => byPlat.has(p)),
        ...Array.from(byPlat.keys()).filter((p) => !PLATFORM_ORDER.includes(p)),
      ]
      groups = ordered.map((p) => ({ name: p, rows: byPlat.get(p)! }))
      if (groups.length === 0) groups = [{ name: 'links', rows: [] }]
    }
    return new NextResponse(toExcel(groups), {
      headers: {
        'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
        'Content-Disposition': `attachment; filename="links_${scope}_${date}.xls"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  return new NextResponse(toCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="links_${scope}_${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
