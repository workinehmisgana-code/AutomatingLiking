import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Client-upload token for guide videos: the browser sends the file straight to
// Vercel Blob, so a 200 MB screen recording never has to fit through the
// serverless request body limit.
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
          // What phones and screen recorders actually produce. octet-stream is
          // included because some browsers report nothing better for .mov/.mkv.
          allowedContentTypes: [
            'video/mp4',
            'video/webm',
            'video/quicktime',
            'video/x-matroska',
            'video/3gpp',
            'application/octet-stream',
          ],
          maximumSizeInBytes: 200 * 1024 * 1024, // 200 MB
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
