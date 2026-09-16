'use client'

import { useEffect, useState } from 'react'

/**
 * Admin card: which model every generation uses.
 *
 * ONE setting for the whole app — comments, replies, title classification and
 * audience analysis all run through the same client, so this changes all of
 * them at once. The card says so, because a picker that looks like it belongs
 * to the comments page would be reached for to fix a comments problem and would
 * quietly change classification too.
 *
 * The test button exists because the failure that matters is not "the model is
 * unavailable" but "the model answers and cannot hold a JSON shape" — every
 * caller asks for JSON and throws on anything else. Switching blind and finding
 * out through a failed nightly run is the thing to avoid.
 */
export default function LlmModelPicker() {
  const [models, setModels] = useState<{ id: string; label: string }[]>([])
  const [model, setModel] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/admin/llm')
      .then((r) => r.json())
      .then((d) => {
        if (d?.error) return setErr(d.error)
        setModel(String(d.model ?? ''))
        setModels(Array.isArray(d.models) ? d.models : [])
      })
      .catch(() => setErr('Could not load the model setting.'))
      .finally(() => setLoading(false))
  }, [])

  async function choose(next: string) {
    if (next === model || saving) return
    setSaving(true)
    setErr('')
    setNote('')
    const previous = model
    setModel(next) // optimistic: the select should not lag the click
    try {
      const res = await fetch('/api/admin/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: next }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setModel(previous)
        setErr(d?.error || 'Could not save.')
        return
      }
      setNote('Saved — every generation from now on uses this model.')
    } catch {
      setModel(previous)
      setErr('Network error.')
    } finally {
      setSaving(false)
    }
  }

  async function test(id: string) {
    setTesting(id)
    setErr('')
    setNote('')
    try {
      const res = await fetch('/api/admin/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(`${id}: ${d?.error || 'no answer'}`)
        return
      }
      setNote(
        d.fellBack
          ? `${id} refused — ${d.model} answered instead in ${d.ms}ms.`
          : `${id} answered in ${d.ms}ms${d.json ? ' with valid JSON.' : ', but NOT valid JSON — generation would fail.'}`
      )
    } catch {
      setErr('Network error while testing.')
    } finally {
      setTesting('')
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <h2 className="text-sm font-semibold text-white mb-1">Language model</h2>
      <p className="text-xs text-zinc-500 mb-3">
        Used for <strong className="text-zinc-400">everything generated</strong> — comments,
        replies, title classification and audience analysis. If the chosen one hits its rate
        limit, the other is used for that request.
      </p>

      {loading ? (
        <p className="text-xs text-zinc-600">Loading…</p>
      ) : (
        <div className="space-y-2">
          {models.map((m) => (
            <label
              key={m.id}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                model === m.id
                  ? 'border-emerald-500/50 bg-emerald-500/10'
                  : 'border-zinc-800 hover:bg-zinc-800/40'
              }`}
            >
              <input
                type="radio"
                name="llm-model"
                checked={model === m.id}
                onChange={() => void choose(m.id)}
                disabled={saving}
                className="accent-emerald-500 cursor-pointer"
              />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-zinc-200">{m.label}</span>
                <span className="block text-[11px] text-zinc-600 truncate">{m.id}</span>
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault()
                  void test(m.id)
                }}
                disabled={testing !== ''}
                title="Send this model one request and report whether it answers with valid JSON"
                className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-100 border border-zinc-700 rounded px-2 py-1 disabled:opacity-40"
              >
                {testing === m.id ? 'testing…' : 'test'}
              </button>
            </label>
          ))}
        </div>
      )}

      {note && <p className="text-xs text-emerald-400 mt-2">{note}</p>}
      {err && <p className="text-xs text-rose-400 mt-2">{err}</p>}
    </div>
  )
}
