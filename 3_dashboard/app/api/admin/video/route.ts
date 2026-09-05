import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { setVideoAccess, type VideoStatus } from '@/lib/db'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

const VALID: VideoStatus[] = ['pending', 'approved', 'rejected']

// POST { userId, status } — admin approves/rejects a user's video request.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let userId = ''
  let status = ''
  try {
    const body = await req.json()
    userId = String(body?.userId ?? '')
    status = String(body?.status ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
  if (!VALID.includes(status as VideoStatus)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  try {
    await setVideoAccess(userId, status as VideoStatus)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
