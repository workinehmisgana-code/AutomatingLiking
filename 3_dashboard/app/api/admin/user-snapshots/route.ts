import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getUserSnapshots, getUserSnapshot } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET ?userId=X  → { snapshots: [{id, day, created_at}] } (list for a user)
// GET ?id=Y      → { day, created_at, snapshot }          (one saved state)
export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const id = req.nextUrl.searchParams.get('id')
  const userId = (req.nextUrl.searchParams.get('userId') || '').trim()
  try {
    if (id) {
      const snap = await getUserSnapshot(Number(id))
      if (!snap) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json(snap)
    }
    if (!userId) return NextResponse.json({ error: 'Missing userId or id' }, { status: 400 })
    const snapshots = await getUserSnapshots(userId)
    return NextResponse.json({ snapshots })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
