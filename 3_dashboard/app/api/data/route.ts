import { list } from '@vercel/blob'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Returns the scraped link dataset. Gated behind a signed-in session so the
// full list isn't downloadable by anonymous callers.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const { blobs } = await list({ prefix: 'videos.json' })
    if (!blobs.length) return NextResponse.json([])
    const res = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Failed to load data' }, { status: 500 })
  }
}
