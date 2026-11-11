import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, REFERRAL_PAY_RATE } from '@/lib/config'
import { adjustPendingPay, getReferralOf, getUserPendingPayments } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { userId, commentBirr } — set this worker's COMMENT pay to `commentBirr`
// birr; videos, reposts and their own referral commission stay as they are.
// (POST { userId, total } — the older form — sets the whole pending pay.)
//
// Written as a comment adjustment (see adjustPendingPay), so the commission
// their referrer earns on them moves with it. The response says by how much.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    userId?: unknown
    total?: unknown
    /** The new COMMENT pay in birr — what the admin edits. The rest of their
     *  pending pay (videos, reposts, their own referral commission) is kept. */
    commentBirr?: unknown
  }
  const userId = String(body.userId ?? '').trim()
  if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  try {
    let total: number
    if (body.commentBirr !== undefined) {
      const commentBirr = Number(body.commentBirr)
      if (!Number.isFinite(commentBirr) || commentBirr < 0) {
        return NextResponse.json({ error: 'Give the new comment pay in birr, 0 or more.' }, { status: 400 })
      }
      // Read now, on the server: the other parts are added back exactly as they
      // stand, so only the comment pay moves.
      const now = await getUserPendingPayments(userId)
      total = now.total - now.comments.birr + commentBirr
    } else {
      total = Number(body.total)
      if (!Number.isFinite(total)) return NextResponse.json({ error: 'Give the new amount in birr.' }, { status: 400 })
    }
    const r = await adjustPendingPay(userId, total, session?.user?.email ?? null)
    const referrer = await getReferralOf(userId).catch(() => null)
    return NextResponse.json({
      ok: true,
      deltaComments: r.deltaComments,
      before: r.before.total,
      after: r.after.total,
      referrer: referrer
        ? { name: referrer.referrerName, deltaBirr: r.deltaComments * REFERRAL_PAY_RATE }
        : null,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}
