'use client'

import { useMemo, useState } from 'react'
import type { RemovalRow } from '@/lib/commentRemoval'

// Admin → Comment removal. Lines of "worker + link" put those workers into
// removal mode: the Android app (not the web dashboard) stops serving them links and walk
// them through deleting their comment on each one. They leave it by themselves
// once every link is crossed off.
export default function RemovalsAdmin({ initial }: { initial: RemovalRow[] }) {
  const [rows, setRows] = useState<RemovalRow[]>(initial)
  const [text, setText] = useState('')
  const [match, setMatch] = useState('null')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)

  async function call(method: string, body: unknown) {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/admin/removals', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      if (Array.isArray(d.rows)) setRows(d.rows)
      return d
    } catch (e) {
      setNote(`Failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function add() {
    const d = await call('POST', { text, matchText: match })
    if (!d) return
    setText('')
    setNote(
      `Added ${d.added} link(s).` +
        (d.skipped?.length ? ` ${d.skipped.length} line(s) skipped — no worker found:\n${d.skipped.join('\n')}` : '')
    )
  }

  // One block per worker: pending first.
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; handle: string | null; pending: RemovalRow[]; done: RemovalRow[] }>()
    for (const r of rows) {
      const g = m.get(r.userId) ?? { name: r.name, handle: r.handle, pending: [], done: [] }
      ;(r.doneAt ? g.done : g.pending).push(r)
      m.set(r.userId, g)
    }
    return Array.from(m.entries())
      .map(([userId, g]) => ({ userId, ...g }))
      .filter((g) => showDone || g.pending.length > 0)
      .sort((a, b) => b.pending.length - a.pending.length || a.name.localeCompare(b.name))
  }, [rows, showDone])

  const pendingTotal = rows.filter((r) => !r.doneAt).length
  const workersIn = new Set(rows.filter((r) => !r.doneAt).map((r) => r.userId)).size
  const doneHow = (r: RemovalRow) =>
    r.doneHow === 'verified' ? '✓ removed (checked on the video)'
      : r.doneHow === 'worker' ? '✓ removed (their word — the video could not be fully read)'
        : r.doneHow === 'admin' ? '✓ marked done by admin' : '✓ done'

  return (
    <main className="max-w-4xl mx-auto px-4 py-8 text-zinc-200">
      <a href="/admin" className="text-xs text-zinc-500 hover:text-zinc-300">← Admin</a>
      <h1 className="text-xl font-semibold mt-2">🧹 Comment removal</h1>
      <p className="text-sm text-zinc-400 mt-1">
        Workers listed here are put into <b>removal mode</b>: the app turns red, stops giving them
        links, and opens each listed link for them to delete their comment. Tapping <b>Removed</b>{' '}
        reads the video; a link is crossed off only when their comment is gone. When none are left,
        the app goes back to normal by itself.
      </p>
      <p className="text-sm mt-3">
        <span className="text-red-300">{workersIn}</span> worker(s) in removal mode ·{' '}
        <span className="text-red-300">{pendingTotal}</span> link(s) still to clean
      </p>

      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="text-sm font-medium">Add</div>
        <p className="text-xs text-zinc-500 mt-1">
          One per line: the worker (their TikTok <code>@handle</code> or email) and the link, in any
          order. The CSV from the &quot;null&quot; scan can be pasted as it is.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder={'@seido.yassin https://www.tiktok.com/@essaydone/video/7707619651739487518\nname@gmail.com https://www.tiktok.com/@x/video/123'}
          className="mt-2 w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-600"
        />
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <label className="text-xs text-zinc-400">
            Only their comments that say{' '}
            <input
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              placeholder="(any comment of theirs)"
              className="ml-1 w-48 rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-sm"
            />
          </label>
          <span className="text-[11px] text-zinc-600">empty = every comment of theirs on the link</span>
          <button
            onClick={add}
            disabled={busy || !text.trim()}
            className="ml-auto text-sm rounded-lg px-4 py-2 bg-red-600 text-white hover:bg-red-500 disabled:opacity-40"
          >
            {busy ? 'Working…' : 'Add to removal mode'}
          </button>
        </div>
        {note && <pre className="text-xs text-zinc-300 mt-2 whitespace-pre-wrap">{note}</pre>}
      </div>

      <div className="flex items-center gap-3 mt-6">
        <label className="text-xs text-zinc-400 flex items-center gap-1">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          show finished
        </label>
      </div>

      <div className="mt-3 space-y-3">
        {groups.length === 0 && <p className="text-sm text-zinc-500">Nobody is in removal mode.</p>}
        {groups.map((g) => (
          <div key={g.userId} className="rounded-xl border border-zinc-800 bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-zinc-800">
              <span className="font-medium">{g.name}</span>
              {g.handle && <span className="text-xs text-zinc-500">@{g.handle}</span>}
              <span className={`text-xs ${g.pending.length ? 'text-red-300' : 'text-emerald-400'}`}>
                {g.pending.length ? `${g.pending.length} to remove` : 'all removed'} · {g.done.length} done
              </span>
              {g.pending.length > 0 && (
                <span className="ml-auto flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => confirm(`Mark all ${g.pending.length} of ${g.name}'s links done?`) &&
                      call('PATCH', { ids: g.pending.map((r) => r.id) })}
                    className="text-xs rounded px-2 py-1 border border-zinc-700 hover:bg-zinc-800"
                  >
                    Mark all done
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => confirm(`Take ${g.name} out of removal mode (delete their ${g.pending.length} pending link(s))?`) &&
                      call('DELETE', { ids: g.pending.map((r) => r.id) })}
                    className="text-xs rounded px-2 py-1 border border-red-900/60 text-red-400 hover:bg-red-950/40"
                  >
                    Remove all
                  </button>
                </span>
              )}
            </div>
            {[...g.pending, ...(showDone ? g.done : [])].map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm border-b border-zinc-800/50 last:border-0">
                <a href={r.url} target="_blank" rel="noreferrer" className="text-sky-400 break-all flex-1 min-w-0">
                  {r.url}
                </a>
                {r.matchText && <span className="text-[11px] text-zinc-500">says &quot;{r.matchText}&quot;</span>}
                <span className={`text-[11px] ${r.doneAt ? 'text-emerald-400' : r.stillText ? 'text-amber-300' : 'text-zinc-500'}`}>
                  {r.doneAt ? doneHow(r) : r.stillText ? `still there (checked ${r.checkedAt?.slice(5, 16).replace('T', ' ')})` : 'waiting'}
                </span>
                {!r.doneAt && (
                  <button
                    disabled={busy}
                    onClick={() => call('PATCH', { ids: [r.id] })}
                    className="text-[11px] rounded px-1.5 py-0.5 border border-zinc-700 hover:bg-zinc-800"
                  >
                    done
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => call('DELETE', { ids: [r.id] })}
                  className="text-[11px] rounded px-1.5 py-0.5 border border-red-900/60 text-red-400 hover:bg-red-950/40"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </main>
  )
}
