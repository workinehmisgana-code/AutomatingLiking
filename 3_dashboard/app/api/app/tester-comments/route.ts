import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { getTesterComments } from '@/lib/testerComments'

export const dynamic = 'force-dynamic'

// GET — the comments the admin set for the Comment Tester app's 💬 list.
// Read-only and recorded nowhere: copying one is not a click.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ comments: await getTesterComments() })
}
