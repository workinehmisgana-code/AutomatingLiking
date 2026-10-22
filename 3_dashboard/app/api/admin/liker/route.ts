import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getLikerSettings, setLikerSettings, LIKER_DEFAULTS } from '@/lib/likerSettings'

export const dynamic = 'force-dynamic'

// The phone liker's settings, read and written by the admin page.
//
// GET  → { settings, defaults }
// POST { settings } → { settings }  (clamped; the stored value is returned)
async function admin() {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ settings: await getLikerSettings(), defaults: LIKER_DEFAULTS })
}

export async function POST(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const incoming = (body as { settings?: unknown })?.settings ?? body
  try {
    // What comes back is what was STORED, not what was sent: the values are
    // clamped on the way in, and the form should show the number the phone will
    // actually use rather than the one that was typed.
    return NextResponse.json({ settings: await setLikerSettings(incoming) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
