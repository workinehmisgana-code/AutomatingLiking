'use client'

import { useState } from 'react'

// The Comment Tester app's 💬 pick list. Only that app reads it; workers never
// see these comments.
export default function TesterCommentsAdmin({ initial }: { initial: string[] }) {
  const [saved, setSaved] = useState<string[]>(initial)
  const [list, setList] = useState<string[]>(initial)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const dirty = JSON.stringify(list) !== JSON.stringify(saved)

  function add() {
    // Several at once: one comment per line.
    const lines = draft.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!lines.length) return
    setList((cur) => cur.concat(lines.filter((l) => !cur.includes(l))))
    setDraft('')
  }

  function edit(i: number, text: string) {
    setList((cur) => cur.map((c, j) => (j === i ? text : c)))
  }

  function move(i: number, by: number) {
    setList((cur) => {
      const j = i + by
      if (j < 0 || j >= cur.length) return cur
      const next = cur.slice()
      const t = next[i]
      next[i] = next[j]
      next[j] = t
      return next
    })
  }

  async function save() {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/admin/tester-comments', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comments: list }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`)
      setSaved(d.comments)
      setList(d.comments)
      setNote('Saved — the app picks it up the next time you open 💬.')
    } catch (e) {
      setNote(`Could not save: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="max-w-3xl mx-auto px-4 py-8 text-zinc-200">
      <a href="/admin" className="text-xs text-zinc-500 hover:text-zinc-300">← Admin</a>
      <h1 className="text-xl font-semibold mt-2">Comment Tester comments</h1>
      <p className="text-sm text-zinc-400 mt-1">
        The list shown by the 💬 button in the <b>Comment Tester</b> app. Tapping one copies it.
        These are for testing only — they are never served to workers, and they are not part of
        any product&apos;s comments.
      </p>

      <div className="mt-6 space-y-2">
        {list.length === 0 && <p className="text-sm text-zinc-500">No comments yet.</p>}
        {list.map((c, i) => (
          <div key={i} className="flex gap-2 items-start">
            <span className="text-xs text-zinc-600 w-6 pt-2 text-right tabular-nums">{i + 1}</span>
            <textarea
              value={c}
              onChange={(e) => edit(i, e.target.value)}
              rows={Math.min(6, Math.max(1, Math.ceil(c.length / 70)))}
              className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-600"
            />
            <div className="flex flex-col gap-1">
              <button onClick={() => move(i, -1)} disabled={i === 0} className="text-xs px-2 rounded border border-zinc-800 text-zinc-400 disabled:opacity-30">↑</button>
              <button onClick={() => move(i, 1)} disabled={i === list.length - 1} className="text-xs px-2 rounded border border-zinc-800 text-zinc-400 disabled:opacity-30">↓</button>
            </div>
            <button
              onClick={() => setList((cur) => cur.filter((_, j) => j !== i))}
              className="text-xs px-2 py-1.5 rounded border border-red-900/60 text-red-400 hover:bg-red-950/40"
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="New comment — one per line to add several"
          className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm focus:outline-none focus:border-zinc-600"
        />
        <div className="flex items-center gap-2 mt-2">
          <button onClick={add} disabled={!draft.trim()} className="text-sm rounded-lg px-3 py-1.5 border border-zinc-700 hover:bg-zinc-800 disabled:opacity-40">
            + Add
          </button>
          <button
            onClick={save}
            disabled={busy || !dirty}
            className="text-sm rounded-lg px-3 py-1.5 bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {dirty && !busy && <span className="text-xs text-amber-400">unsaved changes</span>}
          {note && <span className="text-xs text-zinc-400">{note}</span>}
        </div>
      </div>
    </main>
  )
}
