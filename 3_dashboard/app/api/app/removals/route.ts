import { NextResponse, type NextRequest } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { pendingRemovals } from '@/lib/commentRemoval'

export const dynamic = 'force-dynamic'

// GET — the links this worker must delete their comment from. Empty = normal mode.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const removals = await pendingRemovals(userId).catch(() => [])
  return NextResponse.json({ removalMode: removals.length > 0, removals })
}
