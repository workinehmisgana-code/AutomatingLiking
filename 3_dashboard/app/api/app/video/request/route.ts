import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { requestVideoAccess } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    await requestVideoAccess(userId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
