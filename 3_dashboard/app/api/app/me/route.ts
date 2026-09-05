import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { getUserNameEmail } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET — confirm the app token and return who it belongs to.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const [info, product] = await Promise.all([
    getUserNameEmail(userId).catch(() => null),
    Promise.resolve<string | null>(null),
  ])
  return NextResponse.json({
    name: info?.name ?? '',
    email: info?.email ?? '',
    product,
  })
}
