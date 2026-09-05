import { list } from '@vercel/blob'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Plain-text export of all scraped links, for the Android "Next bubble" app.
// Protected by a shared token (LINKS_EXPORT_TOKEN) rather than a login, since
// the native app can't run Google OAuth. Send it as `Authorization: Bearer <token>`
// or `?token=<token>`. Optional `?platform=tiktok` filters to one platform.
export async function GET(req: NextRequest) {
  const token = process.env.LINKS_EXPORT_TOKEN
  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    req.nextUrl.searchParams.get('token') ||
    ''
  if (!token || provided !== token) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  try {
    const { blobs } = await list({ prefix: 'videos.json' })
    if (!blobs.length) {
      return new NextResponse('', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
    }
    const res = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
    const data = (await res.json()) as Array<{ url?: unknown; platform?: unknown }>
    const platform = req.nextUrl.searchParams.get('platform')
    const urls = (Array.isArray(data) ? data : [])
      .filter((v) => !platform || String(v.platform ?? '') === platform)
      .map((v) => String(v.url ?? '').trim())
      .filter((u) => u.startsWith('http'))

    return new NextResponse(urls.join('\n'), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch {
    return new NextResponse('Failed to load links', { status: 500 })
  }
}
