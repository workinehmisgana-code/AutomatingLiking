import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, REFERRAL_PAY_RATE } from '@/lib/config'
import { adjustPendingPay, getReferralOf } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST { userId, total } — set this worker's pending pay to `total` birr.
//
// Written as a comment adjustment (see adjustPendingPay), so the commission
// their referrer earns on them moves with it. The response says by how much.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as { userId?: unknown; total?: unknown }
  const userId = String(body.userId ?? '').trim()
  const total = Number(body.total)
  if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  if (!Number.isFinite(total)) return NextResponse.json({ error: 'Give the new amount in birr.' }, { status: 400 })
  try {
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
