import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  addRemovalsFromText,
  deleteRemovals,
  listRemovals,
  markRemovalsDone,
} from '@/lib/commentRemoval'

export const dynamic = 'force-dynamic'

// Admin → Comment removal: which workers must delete their comment on which links.
async function admin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

const ids = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ rows: await listRemovals() })
}

/** { text, matchText? } — one worker + link per line. */
export async function POST(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as { text?: unknown; matchText?: unknown }
  const text = String(b.text ?? '')
  if (!text.trim()) return NextResponse.json({ error: 'Nothing to add' }, { status: 400 })
  const matchText = typeof b.matchText === 'string' ? b.matchText : null
  const r = await addRemovalsFromText(text, matchText)
  return NextResponse.json({ ...r, rows: await listRemovals() })
}

/** { ids } — mark done by hand. */
export async function PATCH(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as { ids?: unknown }
  await markRemovalsDone(ids(b.ids), 'admin')
  return NextResponse.json({ rows: await listRemovals() })
}

/** { ids } — take them off the list (the worker leaves removal mode if none are left). */
export async function DELETE(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as { ids?: unknown }
  await deleteRemovals(ids(b.ids))
  return NextResponse.json({ rows: await listRemovals() })
}
