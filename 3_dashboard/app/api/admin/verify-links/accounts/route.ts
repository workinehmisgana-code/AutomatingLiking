import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getVerifyAccounts } from '@/lib/db'

export const dynamic = 'force-dynamic'

// GET — the channels present in the verify list, with their remaining link counts.
// Drives the "merge a whole channel" picker: judging by channel (its bio, what it
// posts) is usually faster than judging link by link.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    return NextResponse.json({ accounts: await getVerifyAccounts() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
