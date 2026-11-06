'use client'

import { useEffect, useState } from 'react'
import { GENRE_LABELS } from '@/lib/config'

/**
 * What counts as RELATED for a genre, editable beside the "Mark unrelated"
 * button it steers. Saves to the database (app_kv 'custom_genres') for an
 * added genre such as Study helper; a built-in genre's definition is code, so
 * it is shown read-only.
 */
export default function RelatedRuleEditor({ genres }: { genres: readonly string[] }) {
  const [open, setOpen] = useState(false)
  const [genre, setGenre] = useState(genres[0] ?? '')
  const [subject, setSubject] = useState('')
  const [keywords, setKeywords] = useState('')
  const [saved, setSaved] = useState({ subject: '', keywords: '' })
  const [editable, setEditable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  // Follow the page: when it switches to another genre, edit that one.
  useEffect(() => {
    if (genres.length && !genres.includes(genre)) setGenre(genres[0])
  }, [genres, genre])

  useEffect(() => {
    if (!open || !genre) return
    let live = true
    setLoading(true)
    setNote(null)
    fetch(`/api/admin/genres/related?genre=${encodeURIComponent(genre)}`, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (!live) return
        if (!r.ok) {
          setNote({ ok: false, text: d?.error || 'Could not load.' })
          return
        }
        const kw = (d.keywords as string[]).join(', ')
        setSubject(d.subject)
        setKeywords(kw)
        setSaved({ subject: d.subject, keywords: kw })
        setEditable(Boolean(d.editable))
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [open, genre])

  async function save() {
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/admin/genres/related', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ genre, subject, keywords: keywords.split(/[\n,]+/) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNote({ ok: false, text: d?.error || 'Could not save.' })
        return
      }
      const kw = (d.keywords as string[]).join(', ')
      setSubject(d.subject)
      setKeywords(kw)
      setSaved({ subject: d.subject, keywords: kw })
      setNote({ ok: true, text: 'Saved. Run “Mark unrelated” again to use it.' })
    } finally {
      setBusy(false)
    }
  }

  const label = GENRE_LABELS[genre] ?? genre
  const changed = subject !== saved.subject || keywords !== saved.keywords
  const area =
    'w-full bg-zinc-950 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-100 disabled:opacity-60'

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={genres.length === 0}
        title="See or change what the Mark unrelated button counts as related"
        className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
      >
        ✏️ What counts as related{open ? ' ▴' : ' ▾'}
      </button>
      {open && (
        <div className="basis-full rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
            <span className="font-semibold text-white">Related to</span>
            {genres.length > 1 ? (
              <select
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                className="bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-100"
              >
                {genres.map((g) => (
                  <option key={g} value={g}>
                    {GENRE_LABELS[g] ?? g}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-white">{label}</span>
            )}
            {!loading && !editable && (
              <span className="text-[11px] text-zinc-500">
                built-in genre — defined in code (lib/prompts.ts), read-only here
              </span>
            )}
          </div>
          {loading ? (
            <div className="text-xs text-zinc-500">Loading…</div>
          ) : (
            <>
              <label className="block text-[11px] text-zinc-400">
                A title is related when it is about…
                <textarea
                  rows={3}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  disabled={!editable || busy}
                  className={area}
                />
              </label>
              <label className="block text-[11px] text-zinc-400">
                Keywords — a title containing one is always related, whatever the model says
                (commas or lines; spaces and punctuation are ignored)
                <textarea
                  rows={2}
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  disabled={!editable || busy}
                  className={area}
                />
              </label>
              {editable && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={busy || !changed}
                    className="text-xs text-white bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 rounded-lg px-3 py-1"
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                  {changed && !busy && (
                    <button
                      type="button"
                      onClick={() => {
                        setSubject(saved.subject)
                        setKeywords(saved.keywords)
                      }}
                      className="text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg px-3 py-1"
                    >
                      Undo changes
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {note && (
            <div className={`text-[11px] ${note.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{note.text}</div>
          )}
        </div>
      )}
    </>
  )
}
