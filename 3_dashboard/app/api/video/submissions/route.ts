import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { addVideoSubmission, getVideoAccess } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Records a video the user just uploaded to Blob (client sends the blob URL).
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  const userId = session?.user?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(userId)
  if (gate) return gate

  const status = await getVideoAccess(userId)
  if (status !== 'approved') {
    return NextResponse.json({ error: 'Not approved to submit videos' }, { status: 403 })
  }

  let url = ''
  let filename: string | null = null
  let size = 0
  try {
    const body = await req.json()
    url = String(body?.url ?? '').trim()
    filename = body?.filename ? String(body.filename) : null
    size = Number(body?.size ?? 0) || 0
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
