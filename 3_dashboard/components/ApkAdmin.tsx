'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { upload } from '@vercel/blob/client'
import type { ApkInfo } from '@/lib/db'

function fmtSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

function fmtDate(iso: string) {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

// Admin card: upload / replace / delete the Android bubble APK that users
// download from their dashboard.
export default function ApkAdmin({ apk }: { apk: ApkInfo | null }) {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    if (!file) return setErr('Choose an .apk file.')
    if (!file.name.toLowerCase().endsWith('.apk')) return setErr('That is not an .apk file.')
    setBusy(true)
    setPct(0)
    try {
      // Keep the original filename as the LAST path segment so the download
      // keeps the exact name the admin uploaded; a timestamp folder makes each
      // upload's path unique (avoids overwrite collisions) without touching it.
      const blob = await upload(`apk/${Date.now()}/${file.name}`, file, {
        access: 'public',
        handleUploadUrl: '/api/admin/apk/upload',
        contentType: 'application/vnd.android.package-archive',
        onUploadProgress: (e) => setPct(Math.round(e.percentage)),
      })
      const res = await fetch('/api/admin/apk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: blob.url,
          filename: file.name,
          size: file.size,
          version: version.trim() || null,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || 'Failed to save APK')
      setMsg('APK published — users can now download it from their dashboard.')
      setFile(null)
      setVersion('')
      router.refresh()
    } catch (e2) {
      setErr((e2 as Error).message || 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!confirm('Remove the current APK? Users will no longer see the download.')) return
    setBusy(true)
    try {
      await fetch('/api/admin/apk', { method: 'DELETE' })
      setMsg('APK removed.')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">🤖</span>
        <h2 className="text-sm font-semibold text-white">Android app (Comment Helper APK)</h2>
      </div>

      {apk ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400 mb-3">
          <span className="text-emerald-400">● published</span>
          <a
            href={apk.url}
            className="text-emerald-400 hover:text-emerald-300 underline break-all"
            target="_blank"
            rel="noopener noreferrer"
          >
            {apk.filename || 'app.apk'}
          </a>
          {apk.version && <span className="text-zinc-300">v{apk.version}</span>}
          {apk.size ? <span>{fmtSize(apk.size)}</span> : null}
          <span className="text-zinc-600">updated {fmtDate(apk.updated_at)}</span>
        </div>
      ) : (
        <p className="text-xs text-amber-300/90 mb-3">
          No APK uploaded yet — users see no download link until you publish one.
        </p>
      )}

      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
          className="text-xs text-zinc-300 file:mr-2 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200 hover:file:bg-zinc-700"
        />
        <input
          type="text"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="version name (e.g. 1.1)"
          disabled={busy}
          title="Must match the app's build.gradle versionName — a higher name (1.1 > 1.0) triggers the auto-update."
          className="w-48 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={busy || !file}
          className="text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {busy ? `Uploading ${pct}%` : apk ? 'Replace APK' : 'Upload APK'}
        </button>
        {apk && (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="text-xs text-red-300 hover:text-red-200 border border-red-500/30 rounded-lg px-3 py-1.5 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
          >
            Remove
          </button>
        )}
      </form>

      {busy && pct > 0 && (
        <div className="mt-2 h-1 w-full rounded bg-zinc-800 overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-emerald-400">{msg}</p>}
      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
    </div>
  )
}
