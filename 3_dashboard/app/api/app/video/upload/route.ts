import { NextRequest, NextResponse } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { userIdFromApp } from '@/lib/appAuth'
import { getVideoAccess } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Client-upload token for the native app to upload a video straight to Vercel
// Blob (bearer-authed). The app sends the {type:'blob.generate-client-token'…}
// body, then PUTs the file to the blob API with the returned clientToken.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await req.json()) as HandleUploadBody
  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        const status = await getVideoAccess(userId)
        if (status !== 'approved') throw new Error('You are not approved to upload videos')
        return {
          allowedContentTypes: [
            'video/mp4',
            'video/quicktime',
            'video/webm',
            'video/x-matroska',
            'video/3gpp',
            'video/x-msvideo',
            'application/octet-stream',
          ],
          maximumSizeInBytes: 200 * 1024 * 1024, // 200 MB
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({ userId }),
        }
      },
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(json)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
