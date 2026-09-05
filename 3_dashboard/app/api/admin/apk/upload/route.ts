import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Client-upload token so the admin can upload the Android APK straight to Vercel
// Blob (bypassing the serverless body-size limit).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody
  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        const session = await auth.api.getSession({ headers: await headers() })
        if (!isAdminEmail(session?.user?.email)) throw new Error('Forbidden')
        return {
          // Browsers report .apk as this type; some report octet-stream/zip.
          allowedContentTypes: [
            'application/vnd.android.package-archive',
            'application/octet-stream',
            'application/zip',
          ],
          maximumSizeInBytes: 200 * 1024 * 1024, // 200 MB
          // Keep the exact uploaded filename — the timestamp folder in the
          // pathname already makes each upload unique, so no random suffix.
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ admin: true }),
        }
      },
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(json)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
