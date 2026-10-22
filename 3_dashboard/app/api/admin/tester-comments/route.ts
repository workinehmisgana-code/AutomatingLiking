import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getTesterComments, setTesterComments } from '@/lib/testerComments'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// GET — the Comment Tester app's pick list.
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ comments: await getTesterComments() })
}

// PUT { comments: string[] } — replace the whole list.
export async function PUT(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { comments?: unknown }
  if (!Array.isArray(body.comments)) {
    return NextResponse.json({ error: 'comments must be a list' }, { status: 400 })
  }
  return NextResponse.json({ comments: await setTesterComments(body.comments) })
}
