import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getTiktokVerifyList } from '@/lib/db'

export const dynamic = 'force-dynamic'

// The local Playwright checker (no browser session) authenticates with the
// x-verify-secret header; an admin browser session also works.
async function authed(req: NextRequest): Promise<boolean> {
  const secret = process.env.VERIFY_SECRET
  const hdr = req.headers.get('x-verify-secret')
  if (secret && hdr && hdr === secret) return true
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// Extract the @username from a TikTok profile URL (lowercased for comparison).
function usernameFromTiktokUrl(url: string): string | null {
  const m = url.match(/@([^/?#\s]+)/)
  return m?.[1] ? m[1].toLowerCase() : null
}

// GET /api/admin/verify-list — each user's TikTok @username + the TikTok sample
// links they submitted while reporting (last 14 days). The checker opens each
// sample link, and if `username` is among the commenters, POSTs to verify-result.
export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const list = await getTiktokVerifyList()
    const users = list
      .map((u) => ({
        userId: u.userId,
        username: usernameFromTiktokUrl(u.tiktokUrl),
        sampleUrls: u.sampleUrls,
      }))
      .filter((u) => u.username) // can't check without a resolvable username
    return NextResponse.json({ users })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
