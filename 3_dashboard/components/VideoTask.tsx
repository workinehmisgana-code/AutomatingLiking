'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { upload } from '@vercel/blob/client'
import { VIDEO_PAYMENT_BIRR } from '@/lib/config'
import type { VideoStatus, VideoSubmission } from '@/lib/db'

function fmtSize(bytes: number) {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

export default function VideoTask({
  status,
  submissions,
  product,
  onReload,
}: {
  status: VideoStatus | null
  submissions: VideoSubmission[]
  product: string | null
  onReload?: () => void
}) {
  const router = useRouter()
  // When rendered inside the client shell, reload re-fetches the page data;
  // otherwise fall back to a full router refresh.
  const reload = onReload ?? (() => router.refresh())
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<FileList | null>(null)
  const [progress, setProgress] = useState('')
  const [pct, setPct] = useState(0)
  const [error, setError] = useState('')

  async function requestAccess() {
    setBusy(true)
    try {
      await fetch('/api/video/request', { method: 'POST' })
      reload()
    } finally {
      setBusy(false)
    }
  }

  async function uploadFiles(e: React.FormEvent) {
    e.preventDefault()
    if (!files || files.length === 0) return
    setError('')
    setBusy(true)
    try {
      const list = Array.from(files)
      for (let i = 0; i < list.length; i++) {
        const f = list[i]
        setProgress(`Uploading ${i + 1}/${list.length}: ${f.name}`)
        setPct(0)
        const blob = await upload(`videos/${Date.now()}-${f.name}`, f, {
          access: 'public',
          handleUploadUrl: '/api/video/upload',
          onUploadProgress: (e) => setPct(Math.round(e.percentage)),
        })
        await fetch('/api/video/submissions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: blob.url, filename: f.name, size: f.size }),
        })
      }
      setProgress('')
      setFiles(null)
      reload()
    } catch (err) {
      setError((err as Error).message || 'Upload failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const total = submissions.length * VIDEO_PAYMENT_BIRR

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white">Video task</h1>
        <Link
          href="/"
          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Links
        </Link>
      </div>
      <p className="text-sm text-zinc-500 mb-5">
        Create a <span className="text-zinc-300">30-second to 1-minute</span> video{' '}
        <span className="text-zinc-300">advertising</span>{' '}
        {product ? (
          <>
            the product <span className="text-emerald-300 font-medium">{product}</span>
          </>
        ) : (
          'one of the products we promote'
        )}
        , and earn <span className="text-emerald-400 font-medium">{VIDEO_PAYMENT_BIRR} birr</span> per
        video.
      </p>

      {/* Access state */}
      {status === 'approved' ? (
        <form onSubmit={uploadFiles} className="border border-emerald-600/40 bg-emerald-600/5 rounded-xl p-4 mb-6">
          <p className="text-sm text-emerald-300 mb-3">✅ You&apos;re approved — upload your videos below.</p>
          <input
            type="file"
            accept="video/*"
            multiple
            onChange={(e) => setFiles(e.target.files)}
            className="block w-full text-sm text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200 hover:file:bg-zinc-700"
          />
          {files?.length && !busy ? (
            <p className="text-xs text-zinc-500 mt-2">{files.length} file(s) selected</p>
          ) : null}
          {busy && (
            <div className="mt-3">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-400 truncate mr-2">{progress}</span>
                <span className="text-emerald-400 tabular-nums shrink-0">{pct}%</span>
              </div>
              <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-150"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
          <button
            type="submit"
            disabled={busy || !files?.length}
            className="mt-3 text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 disabled:opacity-50 transition-colors"
          >
            {busy ? 'Uploading…' : 'Upload video(s)'}
          </button>
        </form>
      ) : status === 'pending' ? (
        <div className="border border-amber-500/40 bg-amber-500/5 rounded-xl p-4 mb-6">
          <p className="text-sm text-amber-300">⏳ Your request is pending admin approval.</p>
          <p className="text-xs text-zinc-500 mt-1">You can upload once an admin approves you.</p>
        </div>
      ) : status === 'rejected' ? (
        <div className="border border-red-500/40 bg-red-500/5 rounded-xl p-4 mb-6">
          <p className="text-sm text-red-300">Your request was declined.</p>
          <button
            onClick={requestAccess}
            disabled={busy}
            className="mt-3 text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 disabled:opacity-50"
          >
            {busy ? 'Requesting…' : 'Request again'}
          </button>
        </div>
      ) : (
        <div className="border border-zinc-800 rounded-xl p-4 mb-6">
          <p className="text-sm text-zinc-400">
            To take part, request permission from the admin. Once approved, you can upload your videos here.
          </p>
          <button
            onClick={requestAccess}
            disabled={busy}
            className="mt-3 text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 disabled:opacity-50"
          >
            {busy ? 'Requesting…' : 'Request permission'}
          </button>
        </div>
      )}

      {/* Submitted videos */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-zinc-300">Your submitted videos</h2>
          {submissions.length > 0 && (
            <span className="text-xs text-zinc-500">
              {submissions.length} · {total.toLocaleString()} birr
            </span>
          )}
        </div>
        {submissions.length === 0 ? (
          <p className="text-sm text-zinc-600">None yet.</p>
        ) : (
          <div className="space-y-1.5">
            {submissions.map((s, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-zinc-800 px-3 py-2">
                <span className="text-zinc-400 text-lg leading-none">🎬</span>
                <div className="min-w-0 flex-1">
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-zinc-200 hover:text-emerald-400 truncate block"
                  >
                    {s.filename || 'video'}
                  </a>
                  <div className="text-xs text-zinc-600">
                    {s.uploaded_at.slice(0, 16).replace('T', ' ')}
                    {s.size ? ` · ${fmtSize(s.size)}` : ''}
                  </div>
                </div>
                {s.paid && (
                  <span className="shrink-0 text-[11px] rounded px-1.5 py-0.5 bg-emerald-600/20 text-emerald-300">
                    Paid ✓
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
