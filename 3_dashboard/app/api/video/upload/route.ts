import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { auth } from '@/lib/auth'
import { hasCompleteProfile, PROFILE_REQUIRED_MESSAGE } from '@/lib/profileGate'
import { getVideoAccess } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Generates a client-upload token so approved users can upload videos straight
// to Vercel Blob (bypassing the serverless request-body size limit).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody
  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        const session = await auth.api.getSession({ headers: await headers() })
        const userId = session?.user?.id
        if (!userId) throw new Error('Unauthorized')
        if (!(await hasCompleteProfile(userId))) throw new Error(PROFILE_REQUIRED_MESSAGE)
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
          ],
          maximumSizeInBytes: 200 * 1024 * 1024, // 200 MB
          tokenPayload: JSON.stringify({ userId }),
        }
      },
      // Recording in the DB happens from the client via /api/video/submissions
      // after upload() resolves (works on localhost, where webhooks don't fire).
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(json)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
