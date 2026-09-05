import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { list, put } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { clearUnrelatedLink, blockLink, blockLinks, unblockLink } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// POST { url, action } — link moderation without deleting from the pool:
//   • action "clear-unrelated" (default): remove the "unrelated" flags (link is
//     actually fine) so it's visible to users again.
//   • action "block": permanently block the link (indeed unrelated). It's filtered
//     out for everyone even if a future videos.json upload re-introduces it. Also
//     clears its unrelated flags since it no longer needs reviewing.
//   • action "unblock": lift a permanent block.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let url = ''
  let urls: string[] = []
  let action = 'clear-unrelated'
  try {
    const b = await req.json()
    url = String(b?.url ?? '').trim()
    if (Array.isArray(b?.urls)) urls = b.urls.map((u: unknown) => String(u).trim()).filter(Boolean)
    if (b?.action) action = String(b.action)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  // Bulk "block all filtered": { urls: [...], action: "block" }
  if (action === 'block' && urls.length > 0) {
    try {
      const blocked = await blockLinks(urls)
      return NextResponse.json({ ok: true, blocked })
    } catch (e) {
      return NextResponse.json({ error: `Action failed: ${String(e)}` }, { status: 500 })
    }
  }
  if (!url) return NextResponse.json({ error: 'No url given' }, { status: 400 })
  try {
    if (action === 'block') {
      await blockLink(url)
      await clearUnrelatedLink(url).catch(() => {})
      return NextResponse.json({ ok: true, blocked: true })
    }
    if (action === 'unblock') {
      const removed = await unblockLink(url)
      return NextResponse.json({ ok: true, unblocked: removed })
    }
    const removed = await clearUnrelatedLink(url)
    return NextResponse.json({ ok: true, removed })
  } catch (e) {
    return NextResponse.json({ error: `Action failed: ${String(e)}` }, { status: 500 })
  }
}

// DELETE { urls: string[] } (or { url }) — permanently remove links from the
// scraped pool (videos.json). Used by the admin Links page to drop links that
// are unrelated to humanizers.
export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'Blob storage is not configured.' }, { status: 500 })
  }

  let urls: string[] = []
  try {
    const b = await req.json()
    if (Array.isArray(b?.urls)) urls = b.urls.map((u: unknown) => String(u))
    else if (b?.url) urls = [String(b.url)]
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const toDelete = new Set(urls.map((u) => u.trim()).filter(Boolean))
  if (toDelete.size === 0) return NextResponse.json({ error: 'No urls given' }, { status: 400 })

  try {
    const { blobs } = await list({ prefix: 'videos.json' })
    if (!blobs.length) return NextResponse.json({ ok: true, removed: 0, count: 0 })
    const res = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
    const data = (await res.json()) as Array<{ url?: unknown }>
    const before = Array.isArray(data) ? data : []
    const kept = before.filter((v) => !toDelete.has(String(v.url ?? '')))
    const removed = before.length - kept.length

    await put('videos.json', JSON.stringify(kept), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    })
    return NextResponse.json({ ok: true, removed, count: kept.length })
  } catch (e) {
    return NextResponse.json({ error: `Failed to update links: ${String(e)}` }, { status: 500 })
  }
}
