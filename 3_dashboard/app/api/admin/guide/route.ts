import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { del } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getGuideVideos,
  addGuideVideo,
  updateGuideVideo,
  deleteGuideVideo,
  moveGuideVideo,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

// The video guides shown on /guide.
//
// Only the admin reaches this route. The guide PAGE reads the same rows through
// getGuideVideos() server-side, so a signed-out visitor gets the clips without
// this endpoint existing for them.

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    return NextResponse.json({ videos: await getGuideVideos() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST { url, filename, size, title, note, lang } — add a clip to the end.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const url = String(b?.url ?? '').trim()
  if (!url.startsWith('http')) return NextResponse.json({ error: 'Missing video url' }, { status: 400 })
  try {
    const video = await addGuideVideo({
      url,
      filename: b?.filename ? String(b.filename) : null,
      size: b?.size != null ? Number(b.size) : null,
      title: String(b?.title ?? ''),
      note: String(b?.note ?? ''),
      lang: String(b?.lang ?? ''),
    })
    return NextResponse.json({ ok: true, video })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// PATCH { id, title?, note?, lang?, move?: 'up' | 'down' }
export async function PATCH(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const id = Number(b?.id)
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  try {
    if (b?.move === 'up' || b?.move === 'down') {
      await moveGuideVideo(id, b.move === 'up' ? -1 : 1)
    } else {
      await updateGuideVideo(id, {
        title: b?.title === undefined ? undefined : String(b.title),
        note: b?.note === undefined ? undefined : String(b.note),
        lang: b?.lang === undefined ? undefined : String(b.lang),
      })
    }
    return NextResponse.json({ ok: true, videos: await getGuideVideos() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// DELETE ?id=N — drop the row and its blob.
export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const id = Number(req.nextUrl.searchParams.get('id'))
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  try {
    const url = await deleteGuideVideo(id)
    // The row is what the page reads, so it goes first; a blob left behind
    // costs storage, a row pointing at a deleted blob shows a broken player.
    if (url) await del(url).catch(() => {})
    return NextResponse.json({ ok: true, videos: await getGuideVideos() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
