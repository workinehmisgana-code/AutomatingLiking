'use client'

import { useCallback, useEffect, useState } from 'react'
import { GENRE_LABELS } from '@/lib/config'

type Settings = {
  enabled: boolean
  clusterBy: 'rank' | 'date' | 'combined'
  clusters: string
  platform: string
  genre: string
  category: string
  maxLinks: number
  keywords: string
  toTop: boolean
  margin: number
  rounds: number
  watch: number
  floor: number
  threshold: number
  share: boolean
}

/**
 * The phone liker's settings.
 *
 * Saving returns what was STORED rather than what was typed — every number is
 * clamped on the server — so the form always shows the value the phone will
 * actually use. A field that silently became something else is how a `floor` of
 * 9 ends up meaning "nine times the video's likes" on a handset nobody is
 * watching.
 */
export default function LikerSettings({ genre }: { genre: string }) {
  const [s, setS] = useState<Settings | null>(null)
  // What the phone is set to right now, when that is not the switch's genre.
  // The switch decides: saving here makes the liker work the switch's genre.
  const [storedGenre, setStoredGenre] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState<{ matched: number; links: number } | null>(null)

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/liker', { cache: 'no-store' })
    const d = await r.json().catch(() => ({}))
    if (d?.settings) {
      const loaded = d.settings as Settings
      setStoredGenre(loaded.genre === genre ? null : loaded.genre)
      setS({ ...loaded, genre })
    } else setErr(d?.error || 'Could not load the settings.')
  }, [genre])

  useEffect(() => {
    load()
  }, [load])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setS((p) => (p ? { ...p, [k]: v } : p))

  async function save() {
    if (!s) return
    setSaving(true)
    setErr('')
    try {
      const r = await fetch('/api/admin/liker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: s }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setErr(d?.error || 'Could not save.')
        return
      }
      setS(d.settings)
      setStoredGenre(null)
      setSaved(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    } finally {
      setSaving(false)
    }
  }

  // What the phone would be handed right now. Worth seeing before switching it
  // on: a cluster selection that matches nothing is a run that does nothing.
  async function check() {
    setPreview(null)
    const r = await fetch('/api/app/liker', { cache: 'no-store' })
    const d = await r.json().catch(() => ({}))
    if (r.ok && d?.ok) setPreview({ matched: d.matched ?? 0, links: (d.links ?? []).length })
    else setErr(d?.error || 'That endpoint answers to the app token, not a browser session.')
  }

  if (!s) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 text-zinc-400">
        {err || 'Loading…'}
      </div>
    )
  }

  const F = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <label className="block">
      <span className="block text-xs text-zinc-400 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-zinc-600 mt-1">{hint}</span>}
    </label>
  )
  const input =
    'w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500'

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8 text-zinc-200">
      <h1 className="text-xl font-semibold mb-1">Phone liker</h1>
      <p className="text-sm text-zinc-400 mb-6">
        What the app does when you press Start on the phone. It holds no settings of its own —
        it asks for these every time it starts, so a change here is what the next run uses.
      </p>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 mb-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
            className="w-5 h-5 accent-emerald-500"
          />
          <span className="text-sm font-medium">
            Let the phone work
            <span className="block text-xs text-zinc-500 font-normal">
              Off and the app says so and stops asking — the switch to pull from here when
              something looks wrong.
            </span>
          </span>
        </label>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">Which links</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <F label="Cluster by">
            <select className={input} value={s.clusterBy} onChange={(e) => set('clusterBy', e.target.value as Settings['clusterBy'])}>
              <option value="rank">Search rank</option>
              <option value="date">Posted date</option>
              <option value="combined">Combined</option>
            </select>
          </F>
          <F label="Clusters" hint="all, or a list like 1,2 — the same numbers as the Links page">
            <input className={input} value={s.clusters} onChange={(e) => set('clusters', e.target.value)} />
          </F>
          <F label="Platform">
            <select className={input} value={s.platform} onChange={(e) => set('platform', e.target.value)}>
              <option value="tiktok">TikTok</option>
              <option value="instagram">Instagram</option>
              <option value="youtube_shorts">YouTube Shorts</option>
            </select>
          </F>
          {/* THE SWITCH'S GENRE. The phone liker runs one genre at a time, and
              it is the one the switch at the top is on when these are saved. */}
          <F label="Product genre" hint="Set by the genre switch at the top">
            <div className={input + ' text-zinc-400'}>{GENRE_LABELS[genre] ?? genre}</div>
            {storedGenre !== null && (
              <div className="text-[11px] text-amber-300 mt-1">
                The phone is working {storedGenre ? (GENRE_LABELS[storedGenre] ?? storedGenre) : 'every genre'} now.
                Saving switches it to {GENRE_LABELS[genre] ?? genre}.
              </div>
            )}
          </F>
          <F label="Audience category" hint="Blank for all">
            <input className={input} value={s.category} onChange={(e) => set('category', e.target.value)} />
          </F>
          <F label="Links per run" hint="How many the phone is handed at a time">
            <input type="number" min={1} max={5000} className={input} value={s.maxLinks}
              onChange={(e) => set('maxLinks', Number(e.target.value))} />
          </F>
          <F label="Products" hint="Blank uses the products you have switched on">
            <input className={input} value={s.keywords} onChange={(e) => set('keywords', e.target.value)}
              placeholder="purifytext, acoustictext" />
          </F>
        </div>
        <p className="text-[11px] text-zinc-600 mt-3">
          Only links already carrying one of our comments are sent — there is nothing for a
          liker to heart on the others.
        </p>
      </div>

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 mb-4">
        <h2 className="text-sm font-semibold mb-3">How many hearts</h2>
        <label className="flex items-center gap-3 cursor-pointer mb-4">
          <input type="checkbox" checked={s.toTop} onChange={(e) => set('toTop', e.target.checked)}
            className="w-4 h-4 accent-emerald-500" />
          <span className="text-sm">Pass the best other comment</span>
        </label>
        <div className="grid sm:grid-cols-2 gap-4">
          <F label="Lead by" hint="Hearts past the best stranger">
            <input type="number" min={1} className={input} value={s.margin}
              onChange={(e) => set('margin', Number(e.target.value))} />
          </F>
          <F label="Batches per video">
            <input type="number" min={1} max={20} className={input} value={s.rounds}
              onChange={(e) => set('rounds', Number(e.target.value))} />
          </F>
          <F label="Floor" hint="Least share of the video's likes — worked even when it leads">
            <input type="number" step={0.05} min={0} max={0.8} className={input} value={s.floor}
              onChange={(e) => set('floor', Number(e.target.value))} />
          </F>
          <F label="Ceiling" hint="Most share of the video's likes a comment may carry">
            <input type="number" step={0.05} min={0.05} max={1} className={input} value={s.threshold}
              onChange={(e) => set('threshold', Number(e.target.value))} />
          </F>
          <F label="Watch the real count for (s)" hint="0 assumes the batch landed in full">
            <input type="number" min={0} max={300} className={input} value={s.watch}
              onChange={(e) => set('watch', Number(e.target.value))} />
          </F>
        </div>
        <p className="text-[11px] text-zinc-600 mt-3">
          The floor is clamped below the ceiling when saved: a comment cannot be required to
          carry more than it is allowed to.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={saving}
          className="text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg px-4 py-2">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button onClick={check}
          className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-4 py-2">
          What would the phone get?
        </button>
        {saved && <span className="text-xs text-emerald-400">saved {saved}</span>}
        {preview && (
          <span className="text-xs text-zinc-400">
            {preview.matched.toLocaleString()} link(s) match · {preview.links.toLocaleString()} would be sent
          </span>
        )}
        {err && <span className="text-xs text-red-400">{err}</span>}
      </div>
    </div>
  )
}
