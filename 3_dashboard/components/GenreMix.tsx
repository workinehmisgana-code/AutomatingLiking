'use client'

import { useCallback, useEffect, useState } from 'react'
import { GENRES, GENRE_LABELS } from '@/lib/config'

/**
 * How much of a worker's list each product genre gets.
 *
 * SHARES, NOT A TOTAL. The three boxes do not have to add up to 100: 60/20/15
 * means the same split as 63/21/16, and a form that refuses to save until the
 * arithmetic is right is a form people fight. The panel shows what the numbers
 * actually come out as underneath, which is the part worth checking.
 *
 * It reports back what was STORED rather than what was typed, so a value that
 * was clamped is visible rather than silently different from what the feeds use.
 */
export default function GenreMix() {
  const [mix, setMix] = useState<Record<string, number> | null>(null)
  const [weights, setWeights] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/genre-mix', { cache: 'no-store' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setErr(d?.error || 'Could not load the genre mix.')
        return
      }
      setMix(d.mix ?? {})
      setWeights(d.weights ?? {})
    } catch {
      setErr('Could not load the genre mix.')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function save(next: Record<string, number>) {
    setSaving(true)
    setErr('')
    try {
      const r = await fetch('/api/admin/genre-mix', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setErr(d?.error || 'Could not save.')
        return
      }
      setMix(d.mix ?? next)
      setWeights(d.weights ?? {})
    } finally {
      setSaving(false)
    }
  }

  if (!mix) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
        {err || 'Loading the genre mix…'}
      </div>
    )
  }

  const total = GENRES.reduce((a, g) => a + (Number(mix[g]) || 0), 0)

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 mb-4">
      <h3 className="text-sm font-semibold text-zinc-200">Genre mix</h3>
      <p className="text-xs text-zinc-500 mt-1 mb-3 leading-relaxed">
        How much of each worker&apos;s list comes from each product genre. The numbers are
        shares, not a total — 60 / 20 / 20 and 6 / 2 / 2 mean the same thing. A genre with
        no links left gives its places to the others rather than leaving the list short.
      </p>

      <div className="grid sm:grid-cols-3 gap-3">
        {GENRES.map((g) => (
          <label key={g} className="block">
            <span className="block text-xs text-zinc-400 mb-1">{GENRE_LABELS[g] ?? g}</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                value={Number(mix[g]) || 0}
                onChange={(e) => setMix({ ...mix, [g]: Number(e.target.value) })}
                onBlur={() => save(mix)}
                className="w-20 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
              <span className="text-xs text-zinc-500 tabular-nums">
                {/* What it actually comes out as, which is the number that matters
                    when the three do not add to a hundred. */}
                → {Math.round((weights[g] ?? 0) * 100)}%
              </span>
            </div>
          </label>
        ))}
      </div>

      <p className="text-[11px] text-zinc-600 mt-3">
        {saving ? 'Saving…' : `Typed total: ${total}. Served shares are on the right.`}
        {total === 0 && ' Nothing set, so everything is served from Humanizer.'}
      </p>
      {err && <p className="text-xs text-red-400 mt-1">{err}</p>}
    </div>
  )
}
