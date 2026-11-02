'use client'

import { useEffect, useState } from 'react'

/**
 * The ratio retirement setting: a TikTok link leaves every worker's list once
 * our products' comments make up this percentage of its comments.
 */
export default function OurRatioRetire() {
  const [pct, setPct] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [retired, setRetired] = useState(0)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    fetch('/api/admin/ratio-retire', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        setPct(d.pct)
        setDraft(String(d.pct))
        setRetired(Number(d.retired) || 0)
      })
      .catch(() => {})
  }, [])

  async function save(v: number) {
    setBusy(true)
    setNote('')
    try {
      const res = await fetch('/api/admin/ratio-retire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pct: v }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNote(d?.error || 'Could not save.')
        return
      }
      setPct(d.pct)
      setDraft(String(d.pct))
      setRetired(Number(d.retired) || 0)
      setNote('Saved — the feeds use it within a minute.')
    } finally {
      setBusy(false)
    }
  }

  if (pct === null) return <div className="text-xs text-zinc-600">Loading ratio retirement…</div>
  const changed = Number(draft) !== pct

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
        <span className="text-sm font-semibold text-white">🎯 TikTok: retire by our comment share</span>
        <span
          className={`text-[11px] rounded px-1.5 py-0.5 border ${
            pct > 0
              ? 'text-amber-200 bg-amber-600/15 border-amber-500/40'
              : 'text-zinc-400 bg-zinc-800 border-zinc-700'
          }`}
        >
          {pct > 0 ? `on · ${retired.toLocaleString()} link(s) retired now` : 'off'}
        </span>
      </div>
      <label className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-zinc-300">
        <span>Retire a TikTok link once our products&apos; comments are</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={100}
          step={0.5}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          className="w-16 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-zinc-100 tabular-nums disabled:opacity-50"
        />
        <span>% or more of its comments</span>
        <button
          type="button"
          onClick={() => void save(Number(draft))}
          disabled={busy || !changed || draft.trim() === ''}
          className="text-xs text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {pct > 0 && (
          <button
            type="button"
            onClick={() => void save(0)}
            disabled={busy}
            className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg px-3 py-1 disabled:opacity-40"
          >
            Turn off
          </button>
        )}
        {note && <span className="text-[11px] text-emerald-400">{note}</span>}
      </label>
      <p className="text-[11px] text-zinc-600 mt-1.5">
        Counted from the comment scan: our comments found on the video over the comment count
        TikTok reports. A link that has not been scanned yet is not affected. Works alongside the
        click quota — a link retires on whichever comes first. 0 turns it off.
      </p>
    </div>
  )
}
