import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { setVideoSubmissionStatus, addAdminMessage, type VideoStatus } from '@/lib/db'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

const VALID: VideoStatus[] = ['pending', 'approved', 'rejected']

// POST { id, status, reason? } — admin accepts/rejects a single video submission.
// On reject, the reason is sent to the user as an admin message (justification).
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let id = 0
  let status = ''
  let reason = ''
  try {
    const body = await req.json()
    id = Number(body?.id)
    status = String(body?.status ?? '')
    reason = String(body?.reason ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
  if (!VALID.includes(status as VideoStatus)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }
  if (status === 'rejected' && !reason) {
    return NextResponse.json({ error: 'A rejection reason is required' }, { status: 400 })
  }

  try {
    const res = await setVideoSubmissionStatus(id, status as VideoStatus, reason || null)
    if (!res) return NextResponse.json({ error: 'Submission not found' }, { status: 404 })
    if (status === 'rejected') {
      const label = res.filename ? `"${res.filename}"` : 'a video you submitted'
      await addAdminMessage(res.userId, `Your video ${label} was rejected: ${reason}`).catch(() => {})
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
