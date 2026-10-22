'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

/**
 * The products' support inboxes, in the admin's top bar beside the users'
 * messages: how many unread emails from real people are waiting across
 * PurifyText, ProHumanly, CoHumanly, Humlexic and AcousticText, and a way into
 * the support desk to answer them.
 *
 * Fetched after the page loads rather than by the server render: reading five
 * Gmail accounts takes seconds, and no admin page should wait on it. Rechecked
 * every two minutes while the page is open (the server caches for as long).
 */
export default function SupportInboxButton() {
  const [state, setState] = useState<{
    total: number
    byProject: { label: string; unread: number }[]
    configured: number
    errors: string[]
  } | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      fetch('/api/admin/support/unread', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive && d?.ok) setState(d)
        })
        .catch(() => {})
    load()
    const t = setInterval(load, 2 * 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const total = state?.total ?? 0
  const title = !state
    ? 'Support inboxes — checking…'
    : state.configured === 0
      ? 'Support inboxes — no product Gmail account is configured yet'
      : [
          `${total} unread email${total === 1 ? '' : 's'} from customers`,
          ...state.byProject.filter((p) => p.unread > 0).map((p) => `${p.label}: ${p.unread}`),
          ...state.errors.map((e) => `⚠ ${e}`),
        ].join('\n')

  return (
    <Link
      href="/admin/support"
      title={title}
      className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 transition-colors ${
        total > 0
          ? 'border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/15 text-violet-200'
          : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700 text-zinc-400'
      }`}
    >
      <span>📥</span>
      <span className="text-sm font-medium tabular-nums">
        {state !== null && total > 0 ? (
          <>
            <span className="text-red-500 font-bold">{total}</span> support
          </>
        ) : (
          'Support'
        )}
      </span>
      {state && state.errors.length > 0 && <span className="text-amber-400 text-xs">⚠</span>}
    </Link>
  )
}
