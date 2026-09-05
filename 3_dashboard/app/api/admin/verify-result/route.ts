import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { setUserValid } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function authed(req: NextRequest): Promise<boolean> {
  const secret = process.env.VERIFY_SECRET
  const hdr = req.headers.get('x-verify-secret')
  if (secret && hdr && hdr === secret) return true
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// POST { userId, valid, days? } — the checker reports a verification result.
// When valid, the user is marked valid for `days` (default 7) from now. A
// not-valid result is a no-op (the user's existing validity just expires).
export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let userId = ''
  let valid = false
  let days = 7
  try {
    const b = await req.json()
    userId = String(b?.userId ?? '').trim()
    valid = b?.valid === true
    if (Number.isFinite(Number(b?.days)) && Number(b?.days) > 0) days = Math.floor(Number(b.days))
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
  try {
    if (valid) await setUserValid(userId, days)
    return NextResponse.json({ ok: true, valid, days })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
