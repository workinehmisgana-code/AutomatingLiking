import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { saveVerifyLinks } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { rows: [{ url, account, view_count, heart_count, comment_count, share_count,
// posted_date, title }] } — upsert a chunk of channel-scraped links into the
// verify-links staging list. The browser parses the CSV and sends it in chunks.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let rows: unknown[] = []
  try {
    const b = await req.json()
    rows = Array.isArray(b?.rows) ? b.rows.slice(0, 2000) : []
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  try {
    const saved = await saveVerifyLinks(rows as never[])
    return NextResponse.json({ saved })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
