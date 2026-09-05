import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { put } from '@vercel/blob'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { addCommentedSubmission, addScreenshot } from '@/lib/db'
import { COMMENT_PLATFORMS } from '@/lib/config'

export const dynamic = 'force-dynamic'

const ALLOWED_IMAGE = /^image\//

// NOTE: sampleUrl is LEGACY. The web form no longer asks for one — verification
// now reads the links a user actually opened, not links they nominate — but the
// field is still accepted so older Android builds that send it keep working, and
// historical values stay readable in the admin view.
//
// A user submits, per platform: how many videos they commented on, a sample URL,
// and any number of comment-history screenshots.
//
// Preferred path: the browser uploads screenshots to Vercel Blob first (see
// /api/finish/upload) and posts JSON here — { platforms: [{ platform, count,
// sampleUrl, screenshots: [url] }] } — so no large body hits this function.
//
// Fallback path (older/cached clients): multipart form-data with fields
// `count_<platform>`, `sample_url_<platform>` and files `files_<platform>`,
// which we upload server-side. Kept so a stale cached page still works.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  const userId = session?.user?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(userId)
  if (gate) return gate

  const contentType = req.headers.get('content-type') || ''

  try {
    if (contentType.includes('application/json')) {
      return await handleJson(req, userId)
    }
    return await handleMultipart(req, userId)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// New path — screenshots already uploaded client-side; we get only URLs.
async function handleJson(req: NextRequest, userId: string) {
  let body: {
    platforms?: { platform?: string; count?: unknown; sampleUrl?: unknown; screenshots?: unknown }[]
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  let counts = 0
  let uploaded = 0
  const seen = new Map<string, { count: number; sampleUrl: string | null; screenshots: string[] }>()
  for (const entry of body?.platforms ?? []) {
    const platform = String(entry?.platform ?? '')
    if (!(COMMENT_PLATFORMS as readonly string[]).includes(platform)) continue
    const count = parseInt(String(entry?.count ?? '0'), 10)
    const n = Number.isFinite(count) && count > 0 ? count : 0
    const sampleUrl = String(entry?.sampleUrl ?? '').trim() || null
    const screenshots = (Array.isArray(entry?.screenshots) ? entry!.screenshots : [])
      .map((u) => String(u).trim())
      .filter((u) => /^https?:\/\//.test(u))
    seen.set(platform, { count: n, sampleUrl, screenshots })
  }

  for (const platform of COMMENT_PLATFORMS) {
    const p = seen.get(platform)
    if (!p) continue
    if (p.count > 0 || p.sampleUrl) {
      await addCommentedSubmission(userId, platform, p.count, p.sampleUrl)
      counts += p.count
    }
    for (const url of p.screenshots) {
      await addScreenshot(userId, platform, url)
      uploaded += 1
    }
  }
  return NextResponse.json({ ok: true, counts, uploaded })
}

// Fallback path — files come in the request body; upload them server-side.
async function handleMultipart(req: NextRequest, userId: string) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'Blob storage is not configured on the server.' }, { status: 500 })
  }
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 })
  }

  let counts = 0
  let uploaded = 0
  for (const platform of COMMENT_PLATFORMS) {
    const count = parseInt(String(form.get(`count_${platform}`) ?? '0'), 10)
    const n = Number.isFinite(count) && count > 0 ? count : 0
    const sampleUrl = String(form.get(`sample_url_${platform}`) ?? '').trim() || null
    if (n > 0 || sampleUrl) {
      await addCommentedSubmission(userId, platform, n, sampleUrl)
      counts += n
    }
    const files = form.getAll(`files_${platform}`).filter((f): f is File => f instanceof File)
    for (const file of files) {
      if (!file.size || !ALLOWED_IMAGE.test(file.type)) continue
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60)
      const blob = await put(`screenshots/${userId}/${platform}/${safe}`, file, {
        access: 'public',
        addRandomSuffix: true,
        contentType: file.type,
      })
      await addScreenshot(userId, platform, blob.url)
      uploaded += 1
    }
  }
  return NextResponse.json({ ok: true, counts, uploaded })
}
