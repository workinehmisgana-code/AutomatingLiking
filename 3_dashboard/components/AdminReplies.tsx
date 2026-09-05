'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

interface Draft {
  id: number
  url: string
  topText: string
  topUser: string | null
  product: string
  reply: string
  createdAt: string
  used: boolean
  commentTotal: number | null
  commentRead: number | null
}

const PAGE = 50

/**
 * Reply drafts for the top comment of each scanned link.
 *
 * These are DRAFTS — nothing is posted from here. The workflow is: read the
 * comment, read the reply, copy it, post it yourself, then tick "used" so the
 * next person doesn't post the same thing again.
 */
export default function AdminReplies() {
  const [rows, setRows] = useState<Draft[]>([])
  const [matched, setMatched] = useState(0)
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState<number | null>(null)
  // Comments judged not to be about humanizers or AI detection. They are
  // recorded so the model is never asked about them twice.
  const [unrelated, setUnrelated] = useState(0)
  const [gen, setGen] = useState(false)
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState<number | null>(null)
  // Word band for the NEXT generation. Held as text so the boxes can be cleared
  // mid-edit, and saved explicitly — it must be set before generating, not after.
  const [bandMin, setBandMin] = useState('8')
  const [bandMax, setBandMax] = useState('22')
  const [bandDirty, setBandDirty] = useState(false)
  const [savingBand, setSavingBand] = useState(false)

  async function saveBand() {
    setSavingBand(true)
    try {
      const res = await fetch('/api/admin/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'band', min: Number(bandMin), max: Number(bandMax) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setNote(d?.error || 'Could not save the word range.'); return }
      // The server clamps and orders it, so show what was actually stored.
      setBandMin(String(d.band.min))
      setBandMax(String(d.band.max))
      setBandDirty(false)
      setNote(`Replies will be ${d.band.min}–${d.band.max} words.`)
    } finally {
      setSavingBand(false)
    }
  }

  const load = useCallback(async (off: number, query: string) => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ offset: String(off), limit: String(PAGE), q: query })
      const res = await fetch(`/api/admin/replies?${p}`)
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setNote(d?.error || 'Could not load.'); return }
      setRows(Array.isArray(d.rows) ? d.rows : [])
      setMatched(Number(d.matched) || 0)
      setOffset(off)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(0, '')
    fetch('/api/admin/replies?pending=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        setPending(Number(d.pending) || 0)
        setUnrelated(Number(d.unrelated) || 0)
        if (d.band) { setBandMin(String(d.band.min)); setBandMax(String(d.band.max)) }
      })
      .catch(() => {})
  }, [load])

  // Generation runs in batches; each POST does what fits its budget and reports
  // how many links still lack a draft.
  async function generate() {
    setGen(true)
    setNote('Generating…')
    try {
      for (;;) {
        const res = await fetch('/api/admin/replies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setNote(d?.error || 'Generation failed.'); break }
        setPending(Number(d.remaining) || 0)
        setUnrelated((u) => u + (Number(d.skipped) || 0))
        setNote(
          `${d.generated ?? 0} drafted` +
          (d.skipped ? ` · ${d.skipped} not related` : '') +
          ` · ${d.remaining ?? 0} link(s) left`
        )
        // A batch that neither drafts nor skips anything is making no progress —
        // stop rather than loop forever burning Groq quota. Skips DO count as
        // progress: they permanently remove a link from the backlog.
        if (d.done || (!d.generated && !d.skipped)) break
      }
      await load(0, q)
    } finally {
      setGen(false)
    }
  }

  async function markUsed(id: number, used: boolean) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, used } : r)))
    await fetch('/api/admin/replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'used', id, used }),
    }).catch(() => {})
  }

  async function copy(r: Draft) {
    try {
      await navigator.clipboard.writeText(r.reply)
      setCopied(r.id)
      setTimeout(() => setCopied((c) => (c === r.id ? null : c)), 1500)
    } catch {
      /* clipboard blocked — the text is selectable on the page anyway */
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Link href="/admin/links" className="text-sm text-zinc-400 hover:text-white">
          ← Links
        </Link>
        <h1 className="text-lg font-semibold text-white">Reply drafts</h1>
        <span className="text-xs text-zinc-500 mr-auto">
          {matched.toLocaleString()} draft{matched === 1 ? '' : 's'}
          {pending !== null && ` · ${pending.toLocaleString()} to do`}
          {unrelated > 0 && (
            <>
              {' · '}
              <span
                title="Top comments judged not to be about humanizers or AI detection. They are skipped and never sent to the model again."
                className="text-zinc-600"
              >
                {unrelated.toLocaleString()} not related
              </span>
            </>
          )}
        </span>
        <label
          className="flex items-center gap-1.5 text-xs text-zinc-400"
          title="Length of the replies the next generation will write. Saved before generating; existing drafts are unaffected."
        >
          reply length
          <input
            type="number"
            min={3}
            max={40}
            value={bandMin}
            onChange={(e) => { setBandMin(e.target.value); setBandDirty(true) }}
            className="w-14 text-xs text-right text-zinc-100 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1 tabular-nums"
          />
          <span className="text-zinc-600">to</span>
          <input
            type="number"
            min={3}
            max={40}
            value={bandMax}
            onChange={(e) => { setBandMax(e.target.value); setBandDirty(true) }}
            className="w-14 text-xs text-right text-zinc-100 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1 tabular-nums"
          />
          words
          {bandDirty && (
            <button
              onClick={saveBand}
              disabled={savingBand}
              className="text-xs text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded px-2 py-1"
            >
              {savingBand ? 'Saving…' : 'Save'}
            </button>
          )}
        </label>
        <button
          onClick={generate}
          disabled={gen || bandDirty}
          title="Write a reply for every scanned link whose top comment has no draft yet."
          className="text-sm text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {gen ? 'Generating…' : '✍ Generate replies'}
        </button>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(0, q) }}
          placeholder="search comment, reply or link, then Enter…"
          className="flex-1 text-sm text-zinc-100 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 focus:outline-none focus:border-violet-500"
        />
        {note && <span className="text-xs text-zinc-500 shrink-0">{note}</span>}
      </div>

      {loading ? (
        <p className="text-sm text-zinc-500 py-10 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500 py-10 text-center">
          No drafts yet. Scan a cluster&apos;s comments on the Links page, then press Generate.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div
              key={r.id}
              className={`rounded-xl border p-3 ${r.used ? 'border-zinc-800 bg-zinc-900/30 opacity-60' : 'border-zinc-700 bg-zinc-900/60'}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-medium text-violet-300 bg-violet-600/15 border border-violet-500/40 rounded px-1.5 py-0.5">
                  {r.product}
                </span>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-sky-400 hover:text-sky-300 truncate min-w-0"
                >
                  {r.url}
                </a>
                {r.commentTotal !== null && (
                  <span
                    className="text-[11px] text-zinc-400 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 shrink-0 tabular-nums"
                    title={
                      r.commentRead !== null && r.commentTotal > r.commentRead
                        ? `${r.commentTotal.toLocaleString()} comments on the video; the scan could read ${r.commentRead.toLocaleString()} of them (the rest are replies or beyond what TikTok serves).`
                        : 'Comments on the video when it was scanned.'
                    }
                  >
                    💬 {r.commentTotal.toLocaleString()}
                    {r.commentRead !== null && r.commentTotal > r.commentRead && (
                      <span className="text-zinc-600"> ({r.commentRead.toLocaleString()} read)</span>
                    )}
                  </span>
                )}
                <span className="ml-auto text-[11px] text-zinc-600 shrink-0">
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </div>

              {/* The comment being replied to */}
              <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-2.5 mb-2">
                <div className="text-[11px] text-zinc-500 mb-0.5">
                  top comment{r.topUser ? ` · @${r.topUser}` : ''}
                </div>
                <div className="text-sm text-zinc-300 break-words">{r.topText}</div>
              </div>

              {/* The reply */}
              <div className="rounded-lg bg-emerald-600/5 border border-emerald-500/30 p-2.5">
                <div className="text-[11px] text-emerald-400/80 mb-0.5">reply</div>
                <div className="text-sm text-zinc-100 break-words">{r.reply}</div>
              </div>

              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => copy(r)}
                  className="text-xs text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-2.5 py-1"
                >
                  {copied === r.id ? 'Copied ✓' : 'Copy reply'}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={r.used}
                    onChange={(e) => markUsed(r.id, e.target.checked)}
                    className="accent-emerald-500"
                  />
                  used
                </label>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mt-4">
        <button
          onClick={() => load(Math.max(0, offset - PAGE), q)}
          disabled={loading || offset === 0}
          className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-3 py-1.5 disabled:opacity-30"
        >
          ← Previous
        </button>
        <span className="text-xs text-zinc-500 tabular-nums">
          {matched === 0 ? '0' : `${offset + 1}–${Math.min(offset + rows.length, matched)}`} of{' '}
          {matched.toLocaleString()}
        </span>
        <button
          onClick={() => load(offset + PAGE, q)}
          disabled={loading || offset + PAGE >= matched}
          className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-3 py-1.5 disabled:opacity-30"
        >
          Next →
        </button>
      </div>
    </div>
  )
}
