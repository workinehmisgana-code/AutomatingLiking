import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { getVideoAccess, getVideoSubmissions, getVideoTaskEnabled } from '@/lib/db'
import { VIDEO_PAYMENT_BIRR } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Native Video-task screen data (bearer-authed).
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const [status, submissions, product, taskEnabled] = await Promise.all([
    getVideoAccess(userId).catch(() => null),
    getVideoSubmissions(userId).catch(() => []),
    Promise.resolve<string | null>(null),
    getVideoTaskEnabled().catch(() => true),
  ])
  return NextResponse.json({ status, submissions, product, payBirr: VIDEO_PAYMENT_BIRR, taskEnabled })
}
