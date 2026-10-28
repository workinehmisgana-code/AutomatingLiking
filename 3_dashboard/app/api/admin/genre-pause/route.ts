import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getAllGenrePauses, liftGenrePause } from '@/lib/db'

export const dynamic = 'force-dynamic'

// The genres the comment check stopped serving to a worker (see the genre rule
// in noCommentVerdict).
//
//   GET                         every worker's paused genres
//   DELETE { userId, genre? }   serve that genre again — every genre if omitted

async function admin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ pauses: await getAllGenrePauses().catch(() => ({})) })
}

export async function DELETE(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { userId?: unknown; genre?: unknown }
  const userId = String(body.userId ?? '').trim()
  const genre = String(body.genre ?? '').trim()
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })
  try {
    await liftGenrePause(userId, genre || undefined)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
