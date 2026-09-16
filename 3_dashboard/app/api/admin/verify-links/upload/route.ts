import { NextRequest, NextResponse } from 'next/server'
import { saveVerifyLinks } from '@/lib/db'
import { isAdminRequest } from '@/lib/machineAuth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { rows: [{ url, account, view_count, heart_count, comment_count, share_count,
// posted_date, title }] } — upsert a chunk of channel-scraped links into the
// verify-links staging list. The browser parses the CSV and sends it in chunks.
//
// Also writable with UPLOAD_SECRET, so the local scraper can hand back what it
// found without a browser session. Nothing reaches users from here: rows land
// in the staging list and still have to be reviewed and merged by hand.
export async function POST(req: NextRequest) {
  if (!(await isAdminRequest(req, 'write'))) {
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
