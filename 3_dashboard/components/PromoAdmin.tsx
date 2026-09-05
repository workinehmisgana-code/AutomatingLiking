'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { upload } from '@vercel/blob/client'
import { PROMO_PLATFORMS, PROMO_PAY_BIRR, PRODUCTS, DEACTIVATED_PRODUCTS } from '@/lib/config'
import type { PromoVideoAdmin } from '@/lib/db'

function fmtSize(bytes: number | null) {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

export default function PromoAdmin({ videos }: { videos: PromoVideoAdmin[] }) {
  const router = useRouter()
  // One product selection governs the whole page: upload + which videos show.
  const [product, setProduct] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const totalOwed =
    videos.reduce((s, v) => s + v.links.filter((l) => !l.paid).length, 0) * PROMO_PAY_BIRR

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    if (!product) return setErr('Choose a product at the top first.')
    if (!file) return setErr('Choose a video file.')
    setBusy(true)
    setPct(0)
    try {
      const blob = await upload(`promo/${Date.now()}-${file.name}`, file, {
        access: 'public',
        handleUploadUrl: '/api/admin/promo/upload',
        onUploadProgress: (e) => setPct(Math.round(e.percentage)),
      })
      const res = await fetch('/api/admin/promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: blob.url, filename: file.name, size: file.size, product }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || 'Failed to save video')
      setMsg(`Video added for ${product}. Users see it with their AI captions on their page.`)
      setFile(null)
      router.refresh()
    } catch (e2) {
      setErr((e2 as Error).message || 'Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  async function patch(body: Record<string, unknown>) {
    await fetch('/api/admin/promo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    router.refresh()
  }

  async function remove(id: number) {
    if (!confirm('Delete this video? Submitted links stay for payment records.')) return
    await fetch('/api/admin/promo', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    router.refresh()
  }

  // Videos scoped to the selected product (all videos until one is chosen).
  const shownVideos = product ? videos.filter((v) => v.product === product) : videos

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white">Promo videos</h1>
        <Link
          href="/admin"
          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Admin
        </Link>
      </div>
      <p className="text-sm text-zinc-500 mb-5">
        Pick a product and upload videos for it. Users assigned that product see the videos with an
        AI-generated list of captions (titles + tags) on their own page, and submit each repost link
        for <span className="text-emerald-400">{PROMO_PAY_BIRR} birr</span>.{' '}
        <span className="text-amber-300">{totalOwed.toLocaleString()} birr</span> owed for unpaid links.
      </p>

      {/* ── One product selector for the whole page ─────────────────────── */}
      <div className="border border-emerald-500/30 bg-emerald-500/5 rounded-xl p-4 mb-5">
        <label className="block text-xs uppercase tracking-wide text-emerald-300 mb-1.5">
          Product <span className="text-emerald-500">*</span>
        </label>
        <select
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
        >
          <option value="">Choose product…</option>
          {PRODUCTS.map((p) => (
            <option key={p} value={p} disabled={DEACTIVATED_PRODUCTS.includes(p)}>
              {p}
              {DEACTIVATED_PRODUCTS.includes(p) ? ' (off)' : ''}
            </option>
          ))}
        </select>
      </div>

      {!product ? (
        <p className="text-sm text-zinc-600 text-center py-10">Choose a product above to begin.</p>
      ) : (
        <>
          {/* Upload */}
          <form onSubmit={submit} className="border border-zinc-800 rounded-xl p-4 mb-6 space-y-3 bg-zinc-900/40">
            <div className="text-sm font-medium text-zinc-300">
              Upload a video for <span className="text-emerald-400">{product}</span>
            </div>
            <input
              type="file"
              accept="video/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-zinc-400 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200 hover:file:bg-zinc-700"
            />
            {busy && (
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-zinc-400">Uploading…</span>
                  <span className="text-emerald-400 tabular-nums">{pct}%</span>
                </div>
                <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 transition-all duration-150" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            {err && <p className="text-xs text-red-400">{err}</p>}
            {msg && <p className="text-xs text-emerald-400">{msg}</p>}
            <button
              type="submit"
              disabled={busy}
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 disabled:opacity-50 transition-colors"
            >
              {busy ? 'Uploading…' : 'Add promo video'}
            </button>
          </form>

          {/* Videos for this product */}
          <h2 className="text-sm font-semibold text-zinc-300 mb-2">
            Videos for {product} · {shownVideos.length}
          </h2>
          {shownVideos.length === 0 ? (
            <p className="text-sm text-zinc-600 text-center py-6">No videos for this product yet.</p>
          ) : (
            <div className="space-y-4">
              {shownVideos.map((v) => (
                <div key={v.id} className="border border-zinc-800 rounded-xl bg-zinc-900/40 overflow-hidden">
                  <div className="flex justify-center bg-black">
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video
                      src={v.url}
                      controls
                      preload="metadata"
                      className="max-h-[60vh] max-w-full w-auto object-contain"
                    />
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm text-zinc-200 min-w-0">
                        {v.filename || 'video'}{' '}
                        <span className="text-xs text-zinc-600">
                          {fmtSize(v.size)} · {v.created_at.slice(0, 10)}
                          {!v.active && ' · inactive'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => patch({ action: 'active', id: v.id, active: !v.active })}
                          className="text-xs text-zinc-300 border border-zinc-700 rounded px-2 py-0.5 hover:bg-zinc-800"
                        >
                          {v.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                        <button
                          onClick={() => remove(v.id)}
                          className="text-xs text-red-400 border border-zinc-700 rounded px-2 py-0.5 hover:bg-zinc-800"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs text-zinc-500 mb-1">Submitted links · {v.links.length}</div>
                      {v.links.length === 0 ? (
                        <div className="text-xs text-zinc-600">None yet.</div>
                      ) : (
                        <div className="space-y-1">
                          {v.links.map((l) => {
                            const label = PROMO_PLATFORMS.find((p) => p.key === l.platform)?.label ?? l.platform
                            return (
                              <div key={l.id} className="flex items-center gap-2 text-xs">
                                <span className="text-zinc-500 w-16 shrink-0">{label}</span>
                                <span className="text-zinc-400 shrink-0">{l.userName}</span>
                                <a
                                  href={l.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-emerald-400 hover:text-emerald-300 truncate flex-1 min-w-0"
                                >
                                  {l.url}
                                </a>
                                <button
                                  onClick={() => patch({ action: 'paid', id: l.id, paid: !l.paid })}
                                  className={`shrink-0 rounded px-1.5 py-0.5 border ${
                                    l.paid
                                      ? 'border-emerald-600/40 bg-emerald-600/20 text-emerald-300'
                                      : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                                  }`}
                                >
                                  {l.paid ? 'Paid ✓' : 'Mark paid'}
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
