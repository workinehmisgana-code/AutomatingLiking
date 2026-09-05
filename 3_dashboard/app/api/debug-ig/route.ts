import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// TEMPORARY diagnostic (no auth required to VIEW) — open in your browser:
//   http://localhost:3000/api/debug-ig
// It reports your session state (does the admin API see you as logged in?) and
// tests a title fetch for each platform straight from THIS server. Delete when done.
const UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'

function metaContent(html: string, prop: string): string | null {
  const m =
    html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i'))
  return m?.[1] ?? null
}
function captionFromJson(html: string): string | null {
  const m = html.match(/"caption":\{"text":"((?:[^"\\]|\\.)*)"/)
  if (!m?.[1]) return null
  let t = m[1]
  try { t = JSON.parse(`"${t}"`) } catch {}
  return t.replace(/\s+/g, ' ').trim() || null
}

async function fetchInstagram(url: string) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, cache: 'no-store' })
    const raw = await r.text()
    const html = raw.slice(0, 1_000_000)
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    return { url, status: r.status, bytes: raw.length, title: tm?.[1] ?? null, ogTitle: metaContent(html, 'og:title'), caption: captionFromJson(html) }
  } catch (e) {
    return { url, error: String(e) }
  }
}

async function fetchYouTube(url: string) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, { cache: 'no-store' })
    const j = r.ok ? await r.json() : null
    return { url, status: r.status, title: j?.title ?? null }
  } catch (e) {
    return { url, error: String(e) }
  }
}

export async function GET(req: NextRequest) {
  // Session / auth check — uses the caller's cookies, exactly like the real route.
  let sessionInfo: Record<string, unknown>
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    sessionInfo = {
      hasSession: !!session,
      email: session?.user?.email ?? null,
      isAdmin: isAdminEmail(session?.user?.email),
    }
  } catch (e) {
    sessionInfo = { error: String(e) }
  }

  const igUrl = req.nextUrl.searchParams.get('ig') || 'https://www.instagram.com/p/DWF-wklDTST/'
  const ytUrl = req.nextUrl.searchParams.get('yt') || 'https://www.youtube.com/watch?v=ZCQhyS2Ad9U'

  const [instagram, youtube] = await Promise.all([fetchInstagram(igUrl), fetchYouTube(ytUrl)])

  return NextResponse.json({
    note: 'If isAdmin is false, the real /api/admin/links/titles route returns 403 and NO server-side titles are fetched.',
    session: sessionInfo,
    instagram,
    youtube,
  })
}
