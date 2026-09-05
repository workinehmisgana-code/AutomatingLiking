import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getUserClicks, removeAllUserClicks } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET /api/admin/user-clicks?userId=<id> — every link the user has clicked
// (opened), newest first. Admin only.
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const userId = (req.nextUrl.searchParams.get('userId') || '').trim()
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
  try {
    const clicks = await getUserClicks(userId)
    return NextResponse.json({ clicks })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// DELETE { userId } — remove all of this user's clicks, giving back one click of
// quota to each link they clicked (used for unverified users). Admin only.
export async function DELETE(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let userId = ''
  try {
    const b = await req.json()
    userId = String(b?.userId ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
  try {
    const removed = await removeAllUserClicks(userId)
    return NextResponse.json({ removed })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
