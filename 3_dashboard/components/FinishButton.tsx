'use client'

import { useState } from 'react'
import { upload } from '@vercel/blob/client'
import { compressImage } from '@/lib/imageCompress'

const PLATFORMS: { key: string; label: string; dot: string }[] = [
  { key: 'tiktok', label: 'TikTok', dot: 'bg-pink-500' },
  { key: 'youtube_shorts', label: 'YT Shorts', dot: 'bg-orange-500' },
  { key: 'youtube_videos', label: 'YT Videos', dot: 'bg-red-500' },
  { key: 'instagram', label: 'Instagram', dot: 'bg-fuchsia-500' },
]

export default function FinishButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [counts, setCounts] = useState<Record<string, string>>({})
  const [files, setFiles] = useState<Record<string, FileList | null>>({})
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  function reset() {
    setCounts({})
    setFiles({})
    setError('')
    setProgress('')
    setDone(false)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    setProgress('')
    try {
      // Count total screenshots up front so we can show upload progress.
      const total = PLATFORMS.reduce(
        (n, p) => n + (files[p.key] ? Array.from(files[p.key]!).filter((f) => f.type.startsWith('image/')).length : 0),
        0
      )
      let uploadedSoFar = 0

      // Upload each screenshot straight to Vercel Blob (bypasses the serverless
      // body-size limit that fails a big multipart submit), collecting URLs.
      const platforms: { platform: string; count: string; screenshots: string[] }[] = []
      for (const p of PLATFORMS) {
        const screenshots: string[] = []
        const list = files[p.key]
        if (list) {
          for (const f of Array.from(list)) {
            if (!f.type.startsWith('image/')) continue
            const idx = uploadedSoFar + 1
            setProgress(`Uploading ${idx}/${total}…`)
            const { data, type } = await compressImage(f) // shrink big photos for reliable upload
            const blob = await upload(`screenshots/${p.key}/${Date.now()}-${f.name}`, data, {
              access: 'public',
              handleUploadUrl: '/api/finish/upload',
              contentType: type,
              onUploadProgress: (e) => setProgress(`Uploading ${idx}/${total} (${Math.round(e.percentage)}%)`),
            })
            screenshots.push(blob.url)
            uploadedSoFar += 1
          }
        }
        platforms.push({
          platform: p.key,
          count: counts[p.key] || '0',
          screenshots,
        })
      }

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

  return (
    <>
      <button
        onClick={() => {
          reset()
          setOpen(true)
        }}
        className={`inline-flex items-center justify-center gap-1.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 shadow-sm ring-2 ring-emerald-400/40 transition-colors ${className}`}
      >
        ✅ Finish &amp; report work
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8 overflow-y-auto">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-lg w-full p-5 my-auto">
            {done ? (
              <div className="text-center py-6">
                <p className="text-3xl mb-3">✅</p>
                <p className="text-lg font-medium text-zinc-200">Submitted</p>
                <p className="text-sm text-zinc-500 mt-1">Your counts and screenshots were sent.</p>
                <button
                  onClick={() => setOpen(false)}
                  className="mt-5 px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                >
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={submit}>
                <h3 className="text-base font-semibold text-white">Finish — report your work</h3>
                <p className="text-sm text-zinc-500 mt-1 mb-4">
                  For each platform, enter how many videos you commented on and attach your
                  comment-history screenshots (you can select multiple).
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

                <div className="flex justify-end gap-2 mt-5">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="px-3 py-1.5 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {saving ? progress || 'Submitting…' : 'Submit'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  )
}
