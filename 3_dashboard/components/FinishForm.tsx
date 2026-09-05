'use client'

import { useState } from 'react'
import Link from 'next/link'
import { upload } from '@vercel/blob/client'
import { compressImage } from '@/lib/imageCompress'

const PLATFORMS: { key: string; label: string; dot: string }[] = [
  { key: 'tiktok', label: 'TikTok', dot: 'bg-pink-500' },
  { key: 'youtube_shorts', label: 'YT Shorts', dot: 'bg-orange-500' },
  { key: 'youtube_videos', label: 'YT Videos', dot: 'bg-red-500' },
  { key: 'instagram', label: 'Instagram', dot: 'bg-fuchsia-500' },
]

// Standalone version of the Finish flow, used by the /finish page (which the
// Android bubble opens in the browser so screenshot uploads work).
export default function FinishForm() {
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [sampleUrls, setSampleUrls] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, FileList | null>>({})
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    setProgress('')
    try {
      // Flatten every image across platforms into one task list so we can upload
      // several at once with a shared progress counter.
      const tasks: { platform: string; file: File; path: string }[] = []
      for (const p of PLATFORMS) {
        const list = files[p.key]
        if (!list) continue
        for (const f of Array.from(list)) {
          if (!f.type.startsWith('image/')) continue
          tasks.push({ platform: p.key, file: f, path: `screenshots/${p.key}/${Date.now()}-${f.name}` })
        }
      }
      const total = tasks.length
      const urlsByPlatform: Record<string, string[]> = {}
      for (const p of PLATFORMS) urlsByPlatform[p.key] = []

      let completed = 0
      setProgress(total ? `Uploading 0/${total} · 0%` : 'Saving…')

      // Upload one file (shrunk first) with a no-progress watchdog: if the request
      // stalls for STALL_MS with no bytes moving, abort and retry. After MAX_ATTEMPTS
      // we throw naming the file, so the submit fails loudly instead of hanging.
      const STALL_MS = 120000 // 2 min of zero progress = a genuine stall
      const MAX_ATTEMPTS = 4
      const uploadOne = async (t: { platform: string; file: File; path: string }): Promise<string> => {
        const { data, type } = await compressImage(t.file) // smaller = far more reliable on mobile
        let lastErr: unknown = null
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const controller = new AbortController()
          let watchdog: ReturnType<typeof setTimeout>
          const arm = () => {
            clearTimeout(watchdog)
            watchdog = setTimeout(() => controller.abort(), STALL_MS)
          }
          arm()
          try {
            const blob = await upload(t.path, data, {
              access: 'public',
              handleUploadUrl: '/api/finish/upload',
              contentType: type,
              abortSignal: controller.signal,
              onUploadProgress: () => arm(), // bytes moved → reset the stall timer
            })
            clearTimeout(watchdog!)
            return blob.url
          } catch (err) {
            clearTimeout(watchdog!)
            lastErr = err
            if (attempt < MAX_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, 1500 * attempt)) // backoff, then retry
            }
          }
        }
        throw new Error(
          `Couldn't upload "${t.file.name}" after ${MAX_ATTEMPTS} tries (${(lastErr as Error)?.message || 'network stalled'}). ` +
            `Check your connection and press Submit again.`
        )
      }

      // Fewer at a time on weak connections → each file keeps enough bandwidth to
      // make progress (3-way splits were starving large uploads into a stall).
      const CONCURRENCY = 2
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < tasks.length) {
          const t = tasks[next++]
          const url = await uploadOne(t)
          urlsByPlatform[t.platform].push(url)
          completed += 1
          setProgress(`Uploading ${completed}/${total} · ${Math.round((completed / total) * 100)}%`)
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker))

      const platforms = PLATFORMS.map((p) => ({
        platform: p.key,
        count: counts[p.key] || '0',
        sampleUrl: sampleUrls[p.key] || '',
        screenshots: urlsByPlatform[p.key],
      }))

      setProgress('Saving…')
      const res = await fetch('/api/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Submit failed. Please try again.')
        return
      }
      setDone(true)
    } catch (err) {
      setError((err as Error)?.message || 'Network error. Please try again.')
    } finally {
      setSaving(false)
      setProgress('')
    }
  }

  if (done) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <p className="text-4xl mb-3">✅</p>
        <p className="text-lg font-medium text-zinc-200">Submitted</p>
        <p className="text-sm text-zinc-500 mt-1">Your counts and screenshots were sent.</p>
        <Link href="/" className="mt-6 inline-block text-sm text-emerald-400 hover:text-emerald-300">
          ← Back to the dashboard
        </Link>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="max-w-lg mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white">Finish — report your work</h1>
        <Link
          href="/"
          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Back
        </Link>
      </div>
      <p className="text-sm text-zinc-500 mt-1 mb-5">
        For each platform, enter how many videos you commented on and attach your comment-history
        screenshots (you can select multiple).
      </p>

      <div className="space-y-4">
        {PLATFORMS.map((p) => (
          <div key={p.key} className="border border-zinc-800 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full ${p.dot}`} />
              <span className="text-sm text-zinc-200">{p.label}</span>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs text-zinc-400">
                Videos commented on
                <input
                  type="number"
                  min={0}
                  value={counts[p.key] ?? ''}
                  onChange={(e) => setCounts((c) => ({ ...c, [p.key]: e.target.value }))}
                  placeholder="0"
                  className="mt-1 w-28 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Sample video URL you commented on
                <input
                  type="url"
                  value={sampleUrls[p.key] ?? ''}
                  onChange={(e) => setSampleUrls((s) => ({ ...s, [p.key]: e.target.value }))}
                  placeholder="https://…"
                  className="mt-1 block w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                />
              </label>
              <label className="text-xs text-zinc-400">
                Screenshots
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => setFiles((f) => ({ ...f, [p.key]: e.target.files }))}
                  className="mt-1 block w-full text-xs text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200 hover:file:bg-zinc-700"
                />
                {files[p.key]?.length ? (
                  <span className="text-emerald-400">{files[p.key]!.length} file(s) selected</span>
                ) : null}
              </label>
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-red-400 mt-3">{error}</p>}

      <button
        type="submit"
        disabled={saving}
        className="mt-5 w-full bg-emerald-600 text-white font-medium rounded-lg px-4 py-2.5 hover:bg-emerald-500 disabled:opacity-50 transition-colors"
      >
        {saving ? progress || 'Submitting…' : 'Submit'}
      </button>
    </form>
  )
}
