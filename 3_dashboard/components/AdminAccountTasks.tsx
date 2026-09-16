'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

interface Row {
  id: number
  userId: string
  email: string
  status: 'pending' | 'approved' | 'rejected'
  rejectReason: string | null
  paid: boolean
  submittedAt: string
  reviewedAt: string | null
  userName: string
  userEmail: string
}

const FILTERS = [
  { key: 'pending', label: 'To check' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
] as const

function fmtBirr(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Reviewing the mailbox task.
//
// APPROVING IS THE PAYMENT — a submission is worth nothing until it is approved
// here, and it cannot be un-approved afterwards. So the button says what it
// costs, and a rejection has to carry a reason the worker can act on.
export default function AdminAccountTasks() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [domain, setDomain] = useState('')
  const [domainBox, setDomainBox] = useState('')
  const [password, setPassword] = useState('')
  const [passwordBox, setPasswordBox] = useState('')
  const [open, setOpen] = useState(false)
  const [rate, setRate] = useState(0)
  const [status, setStatus] = useState<string>('pending')
  const [q, setQ] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busyId, setBusyId] = useState(0)
  // Reviewed in this sitting. Only used to explain why a decided row is sitting
  // in the "To check" list — it is there because you just decided it, not
  // because the filter is broken.
  const [justReviewed, setJustReviewed] = useState<Set<number>>(new Set())
  const [savingSetting, setSavingSetting] = useState(false)

  const load = useCallback(async () => {
    setErr('')
    try {
      const p = new URLSearchParams({ status })
      if (q.trim()) p.set('q', q.trim())
      const res = await fetch(`/api/admin/tasks/accounts?${p}`, { cache: 'no-store' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Could not load.'); return }
      setRows(d.rows ?? [])
      setDomain(d.domain ?? '')
      setDomainBox(d.domain ?? '')
      setPassword(d.password ?? '')
      setPasswordBox(d.password ?? '')
      setOpen(!!d.open)
      setRate(Number(d.rate) || 0)
    } catch {
      setErr('Network error.')
    }
  }, [status, q])

  useEffect(() => {
    load()
    setJustReviewed(new Set())
  }, [load])

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setErr('')
    try {
      const res = await fetch('/api/admin/tasks/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'That did not work.'); return false }
      return true
    } catch {
      setErr('Network error.')
      return false
    }
  }

  async function review(r: Row, approve: boolean) {
    let reason = ''
    if (approve) {
      // Approving is paying. Name the person and the amount, because the list
      // is long and rows look alike.
      if (!confirm(
        `Approve ${r.email}?\n\n` +
          `${r.userName || r.userEmail} is paid ${fmtBirr(rate)} birr for it, and this ` +
          `cannot be undone here.\n\nCheck the mailbox exists before you approve.`
      )) return
    } else {
      const said = prompt(`Why is ${r.email} rejected?\n\nThe worker sees this.`)
      if (said == null) return
      reason = said.trim()
      if (!reason) { setErr('A rejection needs a reason.'); return }
    }
    setBusyId(r.id)
    setMsg('')
    const ok = await post({ id: r.id, approve, reason })
    setBusyId(0)
    if (!ok) return

    setMsg(approve ? `Approved ${r.email} — ${fmtBirr(rate)} birr owed.` : `Rejected ${r.email}.`)
    // PATCHED IN PLACE, NOT RELOADED.
    //
    // Nothing is deleted by a review — it is an UPDATE, and the row is still
    // under Approved and All. But reloading here re-runs the CURRENT filter,
    // and on "To check" the row you just approved no longer matches, so it
    // vanished the instant you acted on it. That reads as "it was removed" and
    // leaves nothing to confirm what you did.
    //
    // So the row stays exactly where it is, wearing its new badge, until the
    // filter is changed or the page is reloaded.
    setRows((prev) =>
      (prev ?? []).map((x) =>
        x.id === r.id
          ? {
              ...x,
              status: approve ? 'approved' : 'rejected',
              rejectReason: approve ? null : reason,
              reviewedAt: new Date().toISOString(),
            }
          : x
      )
    )
    setJustReviewed((prev) => new Set(prev).add(r.id))
  }

  async function saveDomain() {
    setSavingSetting(true)
    setMsg('')
    const ok = await post({ domain: domainBox })
    setSavingSetting(false)
    if (ok) { setMsg('Domain saved.'); await load() }
  }

  async function savePassword() {
    setSavingSetting(true)
    setMsg('')
    const ok = await post({ password: passwordBox })
    setSavingSetting(false)
    if (ok) { setMsg('Password saved. Workers see it on the task page.'); await load() }
  }

  async function toggleOpen() {
    setSavingSetting(true)
    setMsg('')
    const ok = await post({ open: !open })
    setSavingSetting(false)
    if (ok) await load()
  }

  const waiting = (rows ?? []).filter((r) => r.status === 'pending').length
  const decidedHere = (rows ?? []).filter((r) => justReviewed.has(r.id)).length

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-lg font-semibold text-white">Company email task</h1>
        <Link
          href="/admin"
          className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Admin
        </Link>
      </div>
      <p className="text-sm text-zinc-500 mb-4 leading-relaxed">
        Workers create a mailbox on our domain and send the address. Each is worth{' '}
        <span className="text-zinc-300">{fmtBirr(rate)} birr</span> and counts as{' '}
        <span className="text-amber-300">unapproved</span> until you approve it here. Approving is
        the payment — <span className="text-zinc-300">open the mailbox and check it works first</span>.
      </p>

      {/* Settings: the domain, and whether the task is advertised at all. */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[220px]">
            <span className="block text-[11px] uppercase tracking-wide text-zinc-500 mb-1">
              Domain workers must use
            </span>
            <input
              value={domainBox}
              onChange={(e) => setDomainBox(e.target.value)}
              placeholder="example.com"
              spellCheck={false}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
            />
          </label>
          <button
            onClick={saveDomain}
            disabled={savingSetting || domainBox.trim() === domain}
            className="text-sm text-zinc-100 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1.5 disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={toggleOpen}
            disabled={savingSetting || !domain}
            title={
              domain
                ? 'Whether workers are offered this task at all'
                : 'Set a domain first — the task cannot be done without one'
            }
            className={`text-sm rounded-lg px-3 py-1.5 border transition-colors disabled:opacity-40 ${
              open
                ? 'text-emerald-200 bg-emerald-600/20 border-emerald-600/40 hover:bg-emerald-600/30'
                : 'text-zinc-300 bg-zinc-800 border-zinc-700 hover:bg-zinc-700'
            }`}
          >
            {open ? 'Task is OPEN' : 'Task is CLOSED'}
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-3 mt-3">
          <label className="flex-1 min-w-[220px]">
            <span className="block text-[11px] uppercase tracking-wide text-zinc-500 mb-1">
              Password workers must set on the mailbox
            </span>
            <input
              value={passwordBox}
              onChange={(e) => setPasswordBox(e.target.value)}
              placeholder="leave blank to tell them nothing"
              spellCheck={false}
              autoComplete="off"
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
            />
          </label>
          <button
            onClick={savePassword}
            disabled={savingSetting || passwordBox.trim() === password}
            className="text-sm text-zinc-100 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1.5 disabled:opacity-40"
          >
            Save
          </button>
        </div>
        <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
          Shown in full to every worker and written into the guide, so treat it as
          public. One password across every mailbox means one leak is all of them,
          and no single address can be locked out on its own — you own the domain,
          so a different password per address costs the same effort.
        </p>
        {!domain && (
          <p className="text-[11px] text-amber-400/80 mt-2">
            No domain set. Until there is one, the task stays closed and the page tells workers so.
          </p>
        )}
      </div>

      {/* Queue controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex rounded-lg overflow-hidden border border-zinc-700">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatus(f.key)}
              className={`px-2.5 py-1.5 text-sm transition-colors ${
                status === f.key ? 'bg-teal-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              {f.label}
              {f.key === 'pending' && waiting > 0 && status === 'pending' && (
                <span className="ml-1 tabular-nums">({waiting})</span>
              )}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search address or worker"
          className="flex-1 min-w-[180px] bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
        />
      </div>

      {err && <p className="text-sm text-rose-400 mb-2">{err}</p>}
      {msg && <p className="text-sm text-emerald-400 mb-2">{msg}</p>}
      {status === 'pending' && decidedHere > 0 && (
        <p className="text-xs text-zinc-500 mb-2">
          {decidedHere} row{decidedHere === 1 ? '' : 's'} below {decidedHere === 1 ? 'was' : 'were'}{' '}
          decided just now and {decidedHere === 1 ? 'is' : 'are'} kept on screen. Nothing is
          deleted by a review — every address stays under{' '}
          <button
            type="button"
            onClick={() => setStatus('approved')}
            className="text-zinc-300 underline hover:text-white"
          >
            Approved
          </button>{' '}
          and{' '}
          <button
            type="button"
            onClick={() => setStatus('all')}
            className="text-zinc-300 underline hover:text-white"
          >
            All
          </button>
          .
        </p>
      )}

      {!rows ? (
        <p className="text-sm text-zinc-500 py-10 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-600 py-10 text-center">Nothing here.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-zinc-100 break-all flex-1 min-w-[180px]">
                  {r.email}
                </span>
                {r.status === 'pending' ? (
                  <>
                    <button
                      onClick={() => review(r, true)}
                      disabled={busyId === r.id}
                      className="text-xs text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-2.5 py-1 disabled:opacity-40"
                    >
                      {busyId === r.id ? '…' : `Approve · ${fmtBirr(rate)} birr`}
                    </button>
                    <button
                      onClick={() => review(r, false)}
                      disabled={busyId === r.id}
                      className="text-xs text-rose-300 border border-rose-500/40 hover:bg-rose-500/10 rounded-lg px-2.5 py-1 disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <>
                    <span
                      className={`text-[11px] font-semibold rounded px-1.5 py-0.5 border ${
                        r.status === 'approved'
                          ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
                          : 'text-rose-300 bg-rose-500/10 border-rose-500/30'
                      }`}
                    >
                      {r.status === 'approved' ? (r.paid ? 'Approved · paid' : 'Approved') : 'Rejected'}
                    </span>
                    {justReviewed.has(r.id) && (
                      <span
                        className="text-[10px] text-zinc-500"
                        title="Decided in this sitting, and kept here so you can see what you did. It is filed under Approved / All."
                      >
                        just now
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">
                {r.userName || '(no name)'} · {r.userEmail} · sent {fmtWhen(r.submittedAt)}
                {r.reviewedAt && ` · reviewed ${fmtWhen(r.reviewedAt)}`}
              </div>
              {r.status === 'rejected' && r.rejectReason && (
                <p className="text-xs text-rose-300/80 mt-1">Reason: {r.rejectReason}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
