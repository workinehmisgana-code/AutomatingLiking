'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { upload } from '@vercel/blob/client'
import type { GuideVideo } from '@/lib/db'

function fmtSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

/**
 * Admin card: the video guides shown on /guide.
 *
 * A list rather than one asset. The guide covers several separate tasks
 * (commenting, the video task, reposting, the Android app) and each wants its
 * own clip, so clips are added, ordered and removed independently instead of
 * one replacing the last.
 *
 * The guide page is public, so anything published here is visible to anyone
 * with the link, signed in or not. The card says so.
 */
export default function GuideVideosAdmin({ videos }: { videos: GuideVideo[] }) {
  const router = useRouter()
  const [list, setList] = useState<GuideVideo[]>(videos)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [lang, setLang] = useState('')
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    if (!file) return setErr('Choose a video file.')
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|mkv|3gp)$/i.test(file.name)) {
      return setErr('That does not look like a video file.')
    }
    if (!title.trim()) return setErr('Give the clip a title — it is the heading users see.')
    setBusy(true)
    setPct(0)
    try {
      // The original filename stays the last path segment, with a timestamp
      // folder above it so two uploads of "guide.mp4" cannot collide.
      const blob = await upload(`guide/${Date.now()}/${file.name}`, file, {
        access: 'public',
        handleUploadUrl: '/api/admin/guide/upload',
        contentType: file.type || 'video/mp4',
        onUploadProgress: (ev) => setPct(Math.round(ev.percentage)),
      })
      const res = await fetch('/api/admin/guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: blob.url,
          filename: file.name,
          size: file.size,
          title: title.trim(),
          note: note.trim(),
          lang: lang.trim(),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || 'Failed to save the video')
      setList((prev) => [...prev, d.video as GuideVideo])
      setMsg('Published — it is on the guide page now.')
      setFile(null)
      setTitle('')
      setNote('')
      setLang('')
      router.refresh()
    } catch (e2) {
      setErr((e2 as Error).message || 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  async function patch(body: Record<string, unknown>) {
    setErr('')
    const res = await fetch('/api/admin/guide', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) return setErr(d?.error || 'Could not save that.')
    if (Array.isArray(d.videos)) setList(d.videos as GuideVideo[])
    router.refresh()
  }

  async function remove(v: GuideVideo) {
    if (!confirm(`Delete "${v.title || v.filename || 'this clip'}"?\n\nThe video file is deleted too — this cannot be undone.`)) return
    setErr('')
    const res = await fetch(`/api/admin/guide?id=${v.id}`, { method: 'DELETE' })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) return setErr(d?.error || 'Could not delete that.')
    if (Array.isArray(d.videos)) setList(d.videos as GuideVideo[])
    router.refresh()
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <h2 className="text-sm font-semibold text-white">Guide videos</h2>
        <a
          href="/guide"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-emerald-400 hover:text-emerald-300"
        >
          open /guide ↗
        </a>
      </div>
      <p className="text-xs text-zinc-500 mb-3">
        Clips shown on the guide page, in this order. The guide page is public — anyone with
        the link can watch these without signing in.
      </p>

      {list.length === 0 ? (
        <p className="text-xs text-zinc-600 border border-dashed border-zinc-800 rounded-lg px-3 py-4 text-center mb-3">
          No guide videos yet. The guide page shows its written steps only.
        </p>
      ) : (
        <div className="space-y-2 mb-4">
          {list.map((v, i) => (
            <div key={v.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
              <div className="flex items-start gap-2">
                <span className="text-xs text-zinc-600 tabular-nums w-5 shrink-0 pt-1.5">{i + 1}</span>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <input
                    value={v.title}
                    onChange={(e) =>
                      setList((prev) => prev.map((x) => (x.id === v.id ? { ...x, title: e.target.value } : x)))
                    }
                    onBlur={() => void patch({ id: v.id, title: v.title })}
                    placeholder="Title — the heading users see"
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                  />
                  <input
                    value={v.note}
                    onChange={(e) =>
                      setList((prev) => prev.map((x) => (x.id === v.id ? { ...x, note: e.target.value } : x)))
                    }
                    onBlur={() => void patch({ id: v.id, note: v.note })}
                    placeholder="One line about what it shows (optional)"
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={v.lang}
                      onChange={(e) => {
                        const lv = e.target.value
                        setList((prev) => prev.map((x) => (x.id === v.id ? { ...x, lang: lv } : x)))
                        void patch({ id: v.id, lang: lv })
                      }}
                      className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-[11px] text-zinc-300 focus:outline-none focus:border-emerald-500"
                    >
                      <option value="">No language label</option>
                      <option value="en">English</option>
                      <option value="am">አማርኛ</option>
                    </select>
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-zinc-500 hover:text-emerald-400 truncate"
                    >
                      {v.filename || 'video'} {v.size ? `· ${fmtSize(v.size)}` : ''}
                    </a>
                  </div>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => void patch({ id: v.id, move: 'up' })}
                    disabled={i === 0}
                    title="Move up"
                    className="text-xs text-zinc-400 hover:text-white disabled:opacity-30 border border-zinc-700 rounded px-1.5"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => void patch({ id: v.id, move: 'down' })}
                    disabled={i === list.length - 1}
                    title="Move down"
                    className="text-xs text-zinc-400 hover:text-white disabled:opacity-30 border border-zinc-700 rounded px-1.5"
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(v)}
                    title="Delete this clip and its file"
                    className="text-xs text-rose-400 hover:text-rose-300 border border-rose-500/30 rounded px-1.5"
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="space-y-2 border-t border-zinc-800 pt-3">
        <input
          type="file"
          accept="video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-xs text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:bg-zinc-800 file:text-zinc-200 hover:file:bg-zinc-700"
        />
        <div className="flex flex-wrap gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (required)"
            className="flex-1 min-w-[12rem] bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
          />
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500"
          >
            <option value="">No language label</option>
            <option value="en">English</option>
            <option value="am">አማርኛ</option>
          </select>
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="One line about what it shows (optional)"
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
        />
        {busy && (
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        <button
          type="submit"
          disabled={busy}
          className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {busy ? `Uploading ${pct}%…` : '⬆ Add guide video'}
        </button>
        {msg && <p className="text-xs text-emerald-400">{msg}</p>}
        {err && <p className="text-xs text-rose-400">{err}</p>}
      </form>
    </div>
  )
}
