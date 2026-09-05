import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { saveLinkTitles } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { titles: { [url]: string } } — persist titles the client fetched (TikTok
// oEmbed runs in the browser), so they're never re-fetched.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let titles: Record<string, string> = {}
  try {
    const b = await req.json()
    if (b?.titles && typeof b.titles === 'object') {
      for (const [url, title] of Object.entries(b.titles)) {
        if (url && typeof title === 'string' && title.trim()) titles[url] = title.trim()
      }
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  try {
    const saved = await saveLinkTitles(titles)
    return NextResponse.json({ ok: true, saved })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
