'use client'

import { useCallback, useEffect, useState } from 'react'
import type { UnreadReply } from '@/lib/db'

function fmtWhen(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * What users have written, in front of the admin the moment they arrive.
 *
 * These messages had no home. A reply lived inside the user's own card, three
 * hundred cards down a list sorted by clicks, and the only way to find one was
 * to already know it was there — so somebody asking why they had not been paid
 * waited until they asked again somewhere else.
 *
 * TWO RULES it is built around:
 *
 *   CLOSING IS NOT READING. The popup can be dismissed, and everything in it
 *   comes back on the next visit. Only "Done" marks a message as dealt with,
 *   because a message dismissed by accident is one nobody answers and the
 *   person who sent it is waiting for a reply that is never coming.
 *
 *   ANSWERING IS THE POINT. A notification that only tells you something
 *   happened makes work; the reply box is here, and sending clears the message
 *   in the same press.
 */
export default function UserMessagesPopup({ initial }: { initial: UnreadReply[] }) {
  const [replies, setReplies] = useState<UnreadReply[]>(initial)
  const [open, setOpen] = useState(initial.length > 0)
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const [draft, setDraft] = useState<Record<number, string>>({})
  const [err, setErr] = useState('')

  // Esc closes it. A modal that traps somebody who only wanted to look at the
  // page behind it is worse than no modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const markRead = useCallback(async (ids: number[]) => {
    setErr('')
    setBusy(ids.length > 1 ? 'all' : (ids[0] ?? null))
    try {
      const res = await fetch('/api/admin/replies-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'could not save that')
      // The server's list, not ours: two admins on two phones would otherwise
      // each see their own idea of what is left.
      const left: UnreadReply[] = j.replies ?? []
      setReplies(left)
      if (left.length === 0) setOpen(false)
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(null)
    }
  }, [])

  async function reply(r: UnreadReply) {
    const body = (draft[r.id] ?? '').trim()
    if (!body) return
    setErr('')
    setBusy(r.id)
    try {
      const res = await fetch('/api/admin/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: r.userId, body }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || 'could not send that')
      setDraft((d) => ({ ...d, [r.id]: '' }))
      // Answered is dealt with. Leaving it unread after a reply would mean
      // answering the same message twice on the next visit.
      await markRead([r.id])
    } catch (e) {
      setErr(String((e as Error).message || e))
      setBusy(null)
    }
  }

  if (replies.length === 0) return null

  // Closed but not answered: a small bar to get back in, so the messages are
  // never more than one press away.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full mb-4 flex items-center gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 px-3 py-2.5 text-left hover:bg-sky-500/15 transition-colors"
      >
        <span className="text-lg">✉️</span>
        <span className="text-sm text-sky-200 font-medium">
          {replies.length} unanswered message{replies.length === 1 ? '' : 's'} from users
        </span>
        <span className="ml-auto text-xs text-sky-300/80">open</span>
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Messages from users"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
    >
      {/* Bottom sheet on a phone, a centred card on a desktop. The admin reads
          these on a phone as often as not. */}
      <div className="w-full sm:max-w-lg max-h-[88vh] sm:max-h-[80vh] flex flex-col rounded-t-2xl sm:rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
          <span className="text-lg">✉️</span>
          <h2 className="text-sm font-semibold text-white">
            {replies.length} message{replies.length === 1 ? '' : 's'} from users
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="ml-auto text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5"
          >
            Close
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-3 space-y-3">
          {replies.map((r) => (
            <div key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-white">
                  {r.userName || r.userEmail || 'Someone'}
                </span>
                <span className="text-[11px] text-zinc-500">{r.userEmail}</span>
                <span className="ml-auto text-[11px] text-zinc-500">{fmtWhen(r.createdAt)}</span>
              </div>

              {/* What they were replying to. Without it a message like "it is
                  still not working" is a sentence about nothing. */}
              {r.toMessage && (
                <p className="mt-1.5 text-[11px] text-zinc-500 border-l-2 border-zinc-700 pl-2 line-clamp-2">
                  re: {r.toMessage}
                </p>
              )}

              <p className="mt-2 text-sm text-zinc-100 whitespace-pre-wrap break-words">{r.body}</p>

              {(r.phone || r.telegram) && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  {r.phone && (
                    <a
                      href={`tel:${r.phone}`}
                      className="inline-flex items-center min-h-[32px] text-sky-300 hover:text-sky-200 underline decoration-dotted"
                    >
                      📞 {r.phone}
                    </a>
                  )}
                  {r.telegram && (
                    <a
                      href={`https://t.me/${r.telegram}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center min-h-[32px] text-sky-300 hover:text-sky-200 underline decoration-dotted"
                    >
                      ✈️ @{r.telegram}
                    </a>
                  )}
                </div>
              )}

              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  value={draft[r.id] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [r.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void reply(r)
                  }}
                  placeholder="Reply…"
                  className="flex-1 min-w-[160px] bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                />
                <button
                  onClick={() => void reply(r)}
                  disabled={busy === r.id || !(draft[r.id] ?? '').trim()}
                  className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 disabled:opacity-40"
                >
                  {busy === r.id ? '…' : 'Send'}
                </button>
                <button
                  onClick={() => void markRead([r.id])}
                  disabled={busy === r.id}
                  title="Nothing to say back — take it off this list."
                  className="text-sm text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-3 py-1.5 disabled:opacity-40"
                >
                  Done
                </button>
              </div>
            </div>
          ))}
        </div>

        {err && <p className="px-4 text-xs text-rose-400">{err}</p>}

        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-zinc-800">
          <p className="text-[11px] text-zinc-500 mr-auto">
            Closing this keeps them — they are here again next time. Only Done clears one.
          </p>
          <button
            onClick={() => void markRead(replies.map((r) => r.id))}
            disabled={busy === 'all'}
            className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-3 py-1.5 disabled:opacity-40"
          >
            {busy === 'all' ? 'Clearing…' : 'Mark all done'}
          </button>
        </div>
      </div>
    </div>
  )
}
