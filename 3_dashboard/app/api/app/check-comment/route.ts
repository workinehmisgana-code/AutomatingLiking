import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import { getUserProfile } from '@/lib/db'
import { handleFromProfile, judgeLinks } from '@/lib/commentPresence'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { url } — does a comment from THIS user's TikTok account show on that
// video right now? For the Comment Tester app's Check button.
//
// Any comment counts, not only product comments: the question being tested is
// whether what this account posts is visible to everyone else, which is the
// thing a restricted account fails. Read-only — nothing is recorded, so a test
// can never feed the presence ledger or the auto-block rules.
export async function POST(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = (await req.json().catch(() => ({}))) as { url?: unknown }
  const url = String(body.url ?? '').trim()
  if (!/tiktok\.com\//i.test(url)) {
    return NextResponse.json({ error: 'Only TikTok links can be checked.' }, { status: 400 })
  }
  const profile = await getUserProfile(userId).catch(() => null)
  const username = handleFromProfile(profile?.tiktok_url ?? '')
  if (!username) {
    return NextResponse.json({ error: 'Your profile has no TikTok @username.' }, { status: 400 })
  }
  try {
    const [r] = await judgeLinks(username, [url], Date.now() + 45_000)
    return NextResponse.json({
      ok: true,
      username,
      found: !!r?.found,
      // A miss is only certain when the whole comment list could be read; a
      // busy video can have more comments than TikTok will hand over.
      certain: !!r?.judgeable,
      text: r?.text ?? null,
      total: r?.total ?? null,
    })
  } catch (e) {
    return NextResponse.json({ error: `Could not read the comments: ${String(e)}` }, { status: 502 })
  }
}
