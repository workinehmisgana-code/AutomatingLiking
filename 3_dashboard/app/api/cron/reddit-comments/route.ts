import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { warmRedditComments } from '@/lib/redditComments'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Write the per-post comments for Reddit posts that have none yet (see
// lib/redditComments), a few posts per call, so a worker opening a post is
// handed its comments at once instead of waiting for the model. A post nobody
// warmed is still written on the spot when it is opened.
//
// WHO MAY CALL IT: Vercel's scheduler (Bearer $CRON_SECRET), or a signed-in
// admin. ?n= sets how many posts (default 12, at most 30).

function isCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}

async function authorised(req: NextRequest): Promise<boolean> {
  if (isCron(req)) return true
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (isAdminEmail(session?.user?.email)) return true
  return !process.env.CRON_SECRET
}

async function run(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const n = Math.max(1, Math.min(30, Number(req.nextUrl.searchParams.get('n')) || 12))
  try {
    return NextResponse.json({ ok: true, ...(await warmRedditComments(n)) })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

export const GET = run
export const POST = run
