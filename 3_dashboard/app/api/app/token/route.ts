import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { createAppToken, isEmailBlocked } from '@/lib/db'
import { hasCompleteProfile, PROFILE_REQUIRED_MESSAGE } from '@/lib/profileGate'

export const dynamic = 'force-dynamic'

// POST — the browser (after Google sign-in) mints a per-user token for the app.
export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() })
  const userId = session?.user?.id
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (await isEmailBlocked(session?.user?.email).catch(() => false)) {
    return NextResponse.json(
      {
        error: 'Your account is blocked. Open the dashboard to fix it or contact the admin on Telegram.',
        blocked: true,
      },
      { status: 403 }
    )
  }
  // No bank account or TikTok link means we could neither pay this person nor
  // verify their comments, so the app never gets a token.
  if (!(await hasCompleteProfile(userId).catch(() => false))) {
    return NextResponse.json(
      { error: PROFILE_REQUIRED_MESSAGE, needsProfile: true },
      { status: 403 }
    )
  }
  try {
    const token = await createAppToken(userId)
    return NextResponse.json({ token })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
