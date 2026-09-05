import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  approveUserPay,
  unapproveUserPay,
  markUserPaid,
  undoMarkPaid,
  saveUserSnapshot,
  addAdminMessage,
  deleteAdminMessage,
  type MarkPaidUndo,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

/** Birr with thousands separators and no trailing .00 — as the dashboard shows it. */
function fmtBirr(n: number): string {
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? r.toLocaleString() : r.toLocaleString(undefined, { minimumFractionDigits: 2 })
}

// POST { userId, action, undo? }
//   approve    → mark pending pay approved (user sees "Approved")
//   unapprove  → undo of approve
//   paid       → reset counters, record payout, TELL THE USER; returns { amount, undo }
//   undo-paid  → reverse a paid using the provided `undo` descriptor
//
// Marking paid used to change nothing the user could see: their pending balance
// simply dropped to zero with no explanation. It now sends them a message, which
// reaches the app inbox as well as the web dashboard.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const userId = String(b?.userId ?? '')
  const action = String(b?.action ?? '')
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })

  try {
    if (action === 'approve') {
      await approveUserPay(userId)
      return NextResponse.json({ ok: true })
    }
    if (action === 'unapprove') {
      await unapproveUserPay(userId)
      return NextResponse.json({ ok: true })
    }
    if (action === 'paid') {
      // Freeze the user's current state (keyed by day) BEFORE the payment resets
      // the running counters, so past states can be retrieved later.
      if (b?.snapshot && typeof b.snapshot === 'object') {
        const day = new Date().toISOString().slice(0, 10)
        await saveUserSnapshot(userId, day, b.snapshot).catch(() => {})
      }
      const { amount, undo } = await markUserPaid(userId)

      // Tell them. Sent AFTER the payment is recorded, so a failure here can
      // never leave a user told about a payment that did not happen — and never
      // blocks the payment itself, which is the part that matters.
      const messageId = await addAdminMessage(
        userId,
        `Your payment of ${fmtBirr(amount)} birr has been sent to the bank account on your ` +
          `profile. Thank you for your work — your balance starts again from zero.`
      ).catch(() => 0)

      return NextResponse.json({ ok: true, amount, undo: { ...undo, messageId } })
    }
    if (action === 'undo-paid') {
      const undo = b?.undo as MarkPaidUndo | undefined
      await undoMarkPaid(userId, undo as MarkPaidUndo)
      // Withdraw the notice too: leaving "your payment has been sent" in someone's
      // inbox after the payment was reversed is worse than never sending it.
      if (undo?.messageId) await deleteAdminMessage(undo.messageId).catch(() => {})
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
