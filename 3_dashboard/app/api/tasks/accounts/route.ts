import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import {
  isEmailBlocked,
  getAccountTaskDomain,
  getAccountTaskOpen,
  getAccountTaskPassword,
} from '@/lib/db'
import { submitAccountEmail, getUserAccountSubmissions } from '@/lib/db'
import { ACCOUNT_PAY_BIRR, isCompanyEmail } from '@/lib/config'

export const dynamic = 'force-dynamic'

// The mailbox task, from the worker's side.
//
//   GET          the task as it stands for this user: is it open, which domain,
//                what it pays, and everything they have submitted so far.
//   POST { email }  claim ACCOUNT_PAY_BIRR for one address they created.
//
// A submission is NOT payable on arrival — it is worth nothing until an admin
// has checked the address exists. The two numbers the page shows come from
// getUserPendingPayments: `accountsAwaiting` (submitted, unapproved) and
// `accounts` (validated, payable).

async function me() {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return session?.user ?? null
}

export async function GET() {
  const user = await me()
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(user.id)
  if (gate) return gate
  if (await isEmailBlocked(user.email).catch(() => false)) {
    return NextResponse.json({ error: 'Account blocked', blocked: true }, { status: 403 })
  }
  try {
    const [domain, open, password, mine] = await Promise.all([
      getAccountTaskDomain().catch(() => ''),
      getAccountTaskOpen().catch(() => false),
      getAccountTaskPassword().catch(() => ''),
      getUserAccountSubmissions(user.id).catch(() => []),
    ])
    return NextResponse.json({
      ok: true,
      // A task with no domain configured cannot be done, whatever the switch
      // says — so the page is told it is shut rather than shown a form that
      // rejects everything typed into it.
      open: open && !!domain,
      domain,
      // What to set as the mailbox password. Blank = nothing to tell them.
      password,
      rate: ACCOUNT_PAY_BIRR,
      submissions: mine,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const user = await me()
  if (!user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(user.id)
  if (gate) return gate
  if (await isEmailBlocked(user.email).catch(() => false)) {
    return NextResponse.json({ error: 'Account blocked', blocked: true }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as { email?: unknown }
  const email = String(body.email ?? '').trim().toLowerCase()

  const [domain, open] = await Promise.all([
    getAccountTaskDomain().catch(() => ''),
    getAccountTaskOpen().catch(() => false),
  ])
  if (!open || !domain) {
    return NextResponse.json({ error: 'This task is closed right now.' }, { status: 409 })
  }
  // Checked here, not only at review: a worker who typed a gmail address should
  // be told now, while they can still fix it, rather than after a rejection.
  if (!isCompanyEmail(email, domain)) {
    return NextResponse.json(
      { error: `The address must be on @${domain} — that is the only domain we pay for.` },
      { status: 400 }
    )
  }

  const res = await submitAccountEmail(user.id, email)
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 409 })
  return NextResponse.json({ ok: true, submission: res.submission })
}
