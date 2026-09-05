import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { del } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { setApk, deleteApk } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// POST — record the uploaded APK. { url, filename, size, version }
// Replaces any previous APK and deletes its now-orphaned blob.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const url = String(b?.url ?? '').trim()
  if (!url.startsWith('http')) return NextResponse.json({ error: 'Missing APK url' }, { status: 400 })
  try {
    const { prevUrl } = await setApk({
      url,
      filename: b?.filename ? String(b.filename) : null,
      size: b?.size != null ? Number(b.size) : null,
      version: b?.version ? String(b.version).slice(0, 40) : null,
    })
    if (prevUrl) await del(prevUrl).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// DELETE — remove the current APK (record + blob).
export async function DELETE() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const { url } = await deleteApk()
    if (url) await del(url).catch(() => {})
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
