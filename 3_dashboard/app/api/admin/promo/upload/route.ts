import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Client-upload token so the admin can upload promo videos straight to Vercel
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
          allowedContentTypes: [
            'video/mp4',
            'video/quicktime',
            'video/webm',
            'video/x-matroska',
            'video/3gpp',
            'video/x-msvideo',
          ],
          maximumSizeInBytes: 500 * 1024 * 1024, // 500 MB
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
