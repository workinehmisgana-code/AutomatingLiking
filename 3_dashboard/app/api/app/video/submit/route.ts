import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { addVideoSubmission, getVideoAccess, getVideoTaskEnabled } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Records a video the native app just uploaded to Blob (sends the blob URL).
export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!(await getVideoTaskEnabled().catch(() => true))) {
    return NextResponse.json({ error: 'The video task is currently turned off' }, { status: 403 })
  }

  const status = await getVideoAccess(userId)
  if (status !== 'approved') {
    return NextResponse.json({ error: 'Not approved to submit videos' }, { status: 403 })
  }

  let url = ''
  let filename: string | null = null
  let size = 0
  try {
    const b = await req.json()
    url = String(b?.url ?? '').trim()
    filename = b?.filename ? String(b.filename) : null
    size = Number(b?.size ?? 0) || 0
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!/^https?:\/\//.test(url)) return NextResponse.json({ error: 'Invalid url' }, { status: 400 })

  try {
    await addVideoSubmission(userId, url, filename, size)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
