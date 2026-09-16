'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PageLoader, PageError } from '@/components/PageLoader'

interface Submission {
  id: number
  email: string
  status: 'pending' | 'approved' | 'rejected'
  rejectReason: string | null
  paid: boolean
  submittedAt: string
  reviewedAt: string | null
}

interface Data {
  open: boolean
  domain: string
  /** The password to set on the mailbox. '' = we are not telling them one. */
  password: string
  rate: number
  submissions: Submission[]
}

function fmtBirr(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// What each state means TO THE WORKER, in the words they need rather than the
// database's. "Pending" tells someone nothing about whether they are getting
// paid; "waiting to be checked" does.
const STATE: Record<Submission['status'], { label: string; tone: string; hint: string }> = {
  pending: {
    label: 'Waiting to be checked',
    tone: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
    hint: 'We have it. It counts as unapproved until we open the mailbox and confirm it works.',
  },
  approved: {
    label: 'Approved',
    tone: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
    hint: 'Checked and added to your pay.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
    hint: 'Not paid. The reason is below.',
  },
}

export default function AccountTaskClient() {
  const router = useRouter()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState(false)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [msg, setMsg] = useState('')
  const [formErr, setFormErr] = useState('')

  const load = useCallback(async () => {
    setErr(false)
    try {
      const res = await fetch('/api/tasks/accounts', { cache: 'no-store' })
      if (res.status === 401) return router.replace('/')
      if (!res.ok) throw new Error()
      setData(await res.json())
    } catch {
      setErr(true)
    }
  }, [router])

  useEffect(() => {
    load()
  }, [load])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMsg('')
    setFormErr('')
    try {
      const res = await fetch('/api/tasks/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFormErr(d?.error || 'Could not submit that address.')
        return
      }
      setEmail('')
      setMsg('Sent. It will show as unapproved until we have checked it.')
      await load()
    } catch {
      setFormErr('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  if (err) return <PageError onRetry={load} />
  if (!data) return <PageLoader label="Loading the task…" />

  const subs = data.submissions
  const waiting = subs.filter((s) => s.status === 'pending')
  const approved = subs.filter((s) => s.status === 'approved')
  const rejected = subs.filter((s) => s.status === 'rejected')

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-lg font-semibold text-white">Create a company email</h1>
        <Link
          href="/"
          className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Dashboard
        </Link>
      </div>
      <p className="text-sm text-zinc-500 mb-5 leading-relaxed">
        Create an email address on our own domain and send us the address. Each one you create
        earns <span className="text-emerald-300 font-semibold">{fmtBirr(data.rate)} birr</span>.
        The pay shows as <span className="text-amber-300">unapproved</span> until we open the
        mailbox and confirm it works — then it joins your approved pay.
      </p>

      {/* Your money, at the top, because it is the reason anyone is on this page. */}
      <div className="grid grid-cols-3 gap-2 mb-5">
        {[
          { label: 'Approved', n: approved.length, tone: 'text-emerald-400' },
          { label: 'Unapproved', n: waiting.length, tone: 'text-amber-400' },
          { label: 'Rejected', n: rejected.length, tone: 'text-zinc-500' },
        ].map(({ label, n, tone }) => (
          <div key={label} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
            <div className={`text-lg font-semibold tabular-nums ${tone}`}>
              {fmtBirr(n * data.rate)} <span className="text-xs font-normal">birr</span>
            </div>
            <div className="text-[11px] text-zinc-600 tabular-nums">
              {n} address{n === 1 ? '' : 'es'}
            </div>
          </div>
        ))}
      </div>

      {!data.open ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          This task is closed right now. Anything you have already sent is listed below and will
          still be checked and paid.
        </div>
      ) : (
        <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 mb-5">
          {/* The password goes ABOVE the input, because it is an instruction
              for the step before this one: they need it while creating the
              mailbox, not while telling us about it. */}
          {data.password && (
            <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <div className="text-xs text-amber-200/90 mb-1">
                Set this exact password on the mailbox:
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm text-white bg-zinc-950 border border-zinc-700 rounded px-2 py-1 break-all select-all">
                  {data.password}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      void navigator.clipboard?.writeText(data.password)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    } catch {
                      /* clipboard blocked — the password is on screen to type */
                    }
                  }}
                  className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded px-2 py-1"
                >
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
              <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">
                Exactly as written, including the capital letters and symbols. An
                address we cannot sign in to is rejected and not paid.
              </p>
            </div>
          )}
          <label className="block text-sm text-zinc-300 mb-1.5">
            The address you created
            <span className="text-zinc-600"> — it must end in @{data.domain}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setFormErr(''); setMsg('') }}
              placeholder={`yourname@${data.domain}`}
              autoComplete="off"
              spellCheck={false}
              className="flex-1 min-w-[220px] bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
            >
              {busy ? 'Sending…' : 'Send it'}
            </button>
          </div>
          {formErr && <p className="text-sm text-rose-400 mt-2">{formErr}</p>}
          {msg && <p className="text-sm text-emerald-400 mt-2">{msg}</p>}
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
            Send one address per entry. An address someone has already sent us cannot be sent
            again — it is only paid once.
          </p>
        </form>
      )}

      <h2 className="text-sm font-semibold text-white mb-2">
        What you have sent{subs.length > 0 && <span className="text-zinc-500 font-normal"> · {subs.length}</span>}
      </h2>
      {subs.length === 0 ? (
        <p className="text-sm text-zinc-600 py-8 text-center">Nothing sent yet.</p>
      ) : (
        <ul className="space-y-2">
          {subs.map((s) => {
            const st = STATE[s.status]
            return (
              <li key={s.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-zinc-200 break-all flex-1 min-w-[180px]">
                    {s.email}
                  </span>
                  <span className={`text-[11px] font-semibold rounded px-1.5 py-0.5 border ${st.tone}`}>
                    {st.label}
                  </span>
                  <span className="text-[11px] text-zinc-600 tabular-nums">
                    {fmtWhen(s.submittedAt)}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1">{st.hint}</p>
                {s.status === 'rejected' && s.rejectReason && (
                  <p className="text-xs text-rose-300/80 mt-1">Reason: {s.rejectReason}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
