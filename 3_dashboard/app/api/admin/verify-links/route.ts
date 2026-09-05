import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getVerifyLinks,
  deleteVerifyLinks,
  getAllVerifyLinkUrls,
  clearVerifyLinks,
  blockLinks,
  getBlockedUrls,
  type TitleFilter,
} from '@/lib/db'
import { loadVideosJson } from '@/lib/videos'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// Dedup key: URL without query/trailing slash (matches the merge route).
function urlKey(u: unknown): string {
  const raw = String(u ?? '').trim()
  return raw ? raw.split('?')[0].replace(/\/+$/, '') : ''
}

// Drop verify-links that have already been decided, so the staging list only
// ever holds links still awaiting a judgement:
//   • already MERGED  — the URL is in the main list (videos.json)
//   • already BLOCKED — the URL is in blocked_link
//
// The blocked half is what keeps this page and the main Links page agreeing on
// what "blocked" means. Without it a blocked link sits here looking like a fresh
// candidate, you judge it a second time, and merging it would push a link back
// into the pool that every serve path then filters out again.
async function purgeDecidedLinks(): Promise<void> {
  const [videos, verifyUrls, blockedUrls] = await Promise.all([
    loadVideosJson().catch(() => []),
    getAllVerifyLinkUrls().catch(() => [] as string[]),
    getBlockedUrls().catch(() => [] as string[]),
  ])
  if (verifyUrls.length === 0) return
  const mainKeys = new Set(videos.map((v) => urlKey((v as { url?: unknown }).url)).filter(Boolean))
  const blockedKeys = new Set(blockedUrls.map((u) => urlKey(u)).filter(Boolean))
  const decided = verifyUrls.filter((u) => {
    const k = urlKey(u)
    return mainKeys.has(k) || blockedKeys.has(k)
  })
  if (decided.length) await deleteVerifyLinks(decided).catch(() => {})
}

// GET ?page=N&limit=500&title=all|has|none&accounts=a,b,c
//
// One page of the verify-links list plus its counts. `title=has` filters OUT
// every link with no title yet; `title=none` shows only those. `accounts` limits
// the list to those channels, so ticking channels in the picker narrows the table
// to exactly what a channel merge would take. Rows AND the total are filtered
// together, so the pager always describes what is on screen.
export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const page = Math.max(0, Number(req.nextUrl.searchParams.get('page')) || 0)
  const limit = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get('limit')) || 500))
  const titleParam = req.nextUrl.searchParams.get('title')
  const title: TitleFilter = titleParam === 'has' || titleParam === 'none' ? titleParam : 'all'
  // Comma-separated; empty means "every channel".
  const accounts = (req.nextUrl.searchParams.get('accounts') || '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
  try {
    // Clean out already-decided links (merged or blocked) so the page + totals
    // never include them. Only
    // on page 0 (the initial load and every post-upload/merge reload) to avoid a
    // videos.json fetch on every pagination click.
    if (page === 0) await purgeDecidedLinks().catch(() => {})
    const { rows, total, totalAll } = await getVerifyLinks(limit, page * limit, title, accounts)
    return NextResponse.json({ rows, total, totalAll, page, limit, title, accounts })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// DELETE { urls }              — remove specific links from the verify list.
// DELETE { urls, block: true } — ALSO block them permanently first. Used by
//   "Block selected": links judged unrelated should stay out of the pool for
//   good, not merely leave this staging list — otherwise the very next channel
//   scrape or videos.json upload re-introduces them and they have to be judged
//   all over again. Blocking is recorded per URL and survives re-uploads.
// DELETE { all: true }         — wipe the ENTIRE verify list (never blocks).
export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let urls: string[] = []
  let all = false
  let block = false
  try {
    const b = await req.json()
    all = b?.all === true
    block = b?.block === true
    urls = Array.isArray(b?.urls) ? b.urls.map((u: unknown) => String(u ?? '').trim()).filter(Boolean) : []
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  try {
    if (all) return NextResponse.json({ removed: await clearVerifyLinks(), blocked: 0 })
    // Block BEFORE removing: if the block fails we keep the links in the verify
    // list so the decision isn't silently lost.
    const blocked = block ? await blockLinks(urls) : 0
    const removed = await deleteVerifyLinks(urls)
    return NextResponse.json({ removed, blocked })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
