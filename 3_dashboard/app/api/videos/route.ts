import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { getVideoAccess, getVideoSubmissions, getVideoTaskEnabled, isEmailBlocked } from '@/lib/db'

export const dynamic = 'force-dynamic'

// The data the /videos page needs, loaded client-side so navigation is instant.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(session.user.id)
  if (gate) return gate
  if (await isEmailBlocked(session.user.email).catch(() => false)) {
    return NextResponse.json({ error: 'Account blocked', blocked: true }, { status: 403 })
  }

  const [status, submissions, product, taskEnabled] = await Promise.all([
    getVideoAccess(session.user.id).catch(() => null),
    getVideoSubmissions(session.user.id).catch(() => []),
    Promise.resolve<string | null>(null),
    getVideoTaskEnabled().catch(() => true),
  ])
  return NextResponse.json({ status, submissions, product, taskEnabled })
}
