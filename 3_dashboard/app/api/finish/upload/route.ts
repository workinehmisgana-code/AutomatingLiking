import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { auth } from '@/lib/auth'
import { hasCompleteProfile, PROFILE_REQUIRED_MESSAGE } from '@/lib/profileGate'

export const dynamic = 'force-dynamic'

// Client-upload token so screenshots go straight from the browser to Vercel
// Blob — bypassing the serverless request-body limit that fails a big multipart
// Finish submit. The Finish form then posts only the resulting URLs to /api/finish.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody
  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        const session = await auth.api.getSession({ headers: await headers() })
        if (!session?.user?.id) throw new Error('Unauthorized')
        if (!(await hasCompleteProfile(session.user.id))) throw new Error(PROFILE_REQUIRED_MESSAGE)
        return {
          allowedContentTypes: [
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/webp',
            'image/heic',
            'image/heif',
            'image/gif',
            'image/bmp',
            'image/*',
          ],
          maximumSizeInBytes: 25 * 1024 * 1024, // 25 MB per screenshot
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: session.user.id }),
        }
      },
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(json)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
