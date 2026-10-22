import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, ACCOUNT_PAY_BIRR } from '@/lib/config'
import {
  getAccountSubmissions,
  reviewAccountSubmission,
  markAccountSubmissionsPaid,
  unmarkAccountSubmissionPaid,
  getAccountPayByUser,
  getAccountTaskDomain,
  setAccountTaskDomain,
  getAccountTaskOpen,
  setAccountTaskOpen,
  getAccountTaskPassword,
  getAccountTaskRecovery,
  setAccountTaskPassword,
  setAccountTaskRecovery,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

// The mailbox task, from the admin's side.
//
//   GET ?status=pending|approved|rejected|all&q=          the review queue
//   POST { id, approve, reason }                          validate one address
//   POST { payIds: [id] } | { payUser: userId }            mark mailboxes PAID
//   POST { unpayId: id }                                   undo one payment mark
//   POST { domain }                                       set the domain
//   POST { password }                                     set the mailbox password
//   POST { recovery }                                     set the recovery address
//   POST { open }                                         open/close the task
//
// APPROVING IS THE PAYMENT. A submission sits outside the payable total until
// it is approved here, so this endpoint is the only thing that turns a claim
// into money owed — which is why it reviews one submission at a time and
// refuses to re-review one that has already been decided.

async function requireAdmin(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!isAdminEmail(session?.user?.email)) return null
  return session?.user?.id ?? 'admin'
}

export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const sp = req.nextUrl.searchParams
  try {
    // `pay` is the per-worker owed list this page settles from. Fetched with
    // the rows rather than behind its own request: the page shows both at
    // once, and two round trips would let them disagree on screen.
    const [rows, domain, open, password, recovery, pay] = await Promise.all([
      getAccountSubmissions({
        status: sp.get('status') ?? 'pending',
        q: sp.get('q') ?? '',
        limit: Number(sp.get('limit')) || 500,
      }),
      getAccountTaskDomain().catch(() => ''),
      getAccountTaskOpen().catch(() => false),
      getAccountTaskPassword().catch(() => ''),
      getAccountTaskRecovery().catch(() => ''),
      getAccountPayByUser().catch(() => []),
    ])
    return NextResponse.json({
      ok: true, rows, domain, open, password, recovery, pay, rate: ACCOUNT_PAY_BIRR,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const adminId = await requireAdmin()
  if (!adminId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as {
    id?: unknown
    approve?: unknown
    reason?: unknown
    domain?: unknown
    password?: unknown
    recovery?: unknown
    open?: unknown
    payIds?: unknown
    payUser?: unknown
    unpayId?: unknown
  }

  try {
    if (typeof b.domain === 'string') {
      const saved = await setAccountTaskDomain(b.domain)
      return NextResponse.json({ ok: true, domain: saved })
    }
    if (typeof b.recovery === 'string') {
      const saved = await setAccountTaskRecovery(b.recovery)
      return NextResponse.json({ ok: true, recovery: saved })
    }

    if (typeof b.password === 'string') {
      const saved = await setAccountTaskPassword(b.password)
      return NextResponse.json({ ok: true, password: saved })
    }
    if (typeof b.open === 'boolean') {
      const open = await setAccountTaskOpen(b.open)
      return NextResponse.json({ ok: true, open })
    }

    // ── paying for mailboxes, here rather than on the user card ───────────
    //
    // Email work is settled on this page because it is checked on this page: the
    // admin has just confirmed the address exists and is looking at it. Marking
    // it paid takes it out of the user's main balance by itself — the pending
    // total counts `approved AND NOT paid`, so there is one fact, in one place,
    // and no way to pay the same mailbox from two screens.
    if (Array.isArray(b.payIds) || typeof b.payUser === 'string') {
      const ids = Array.isArray(b.payIds)
        ? (b.payIds as unknown[]).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
        : []
      const payUser = typeof b.payUser === 'string' ? b.payUser.trim() : ''
      if (ids.length === 0 && !payUser) {
        return NextResponse.json({ error: 'Nothing to pay.' }, { status: 400 })
      }
      const res = await markAccountSubmissionsPaid({ ids, userId: payUser })
      return NextResponse.json({ ok: true, ...res })
    }
    if (b.unpayId !== undefined) {
      const undo = Number(b.unpayId)
      if (!Number.isFinite(undo) || undo <= 0) {
        return NextResponse.json({ error: 'Which submission?' }, { status: 400 })
      }
      const ok = await unmarkAccountSubmissionPaid(undo)
      return NextResponse.json(
        ok ? { ok: true } : { error: 'That one is not marked paid.' },
        { status: ok ? 200 : 409 }
      )
    }

    const id = Number(b.id)
    if (!Number.isFinite(id) || id <= 0) {
      return NextResponse.json({ error: 'Which submission?' }, { status: 400 })
    }
    const approve = b.approve === true
    const reason = String(b.reason ?? '')
    // A rejection with no reason is a message the worker cannot act on, and
    // this is their pay. Make it say something.
    if (!approve && !reason.trim()) {
      return NextResponse.json({ error: 'Give a reason for the rejection.' }, { status: 400 })
    }
    const res = await reviewAccountSubmission(id, adminId, approve, reason)
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
