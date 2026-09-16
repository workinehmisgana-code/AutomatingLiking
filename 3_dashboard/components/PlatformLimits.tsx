'use client'

import { useEffect, useState } from 'react'
import { CLICK_PLATFORMS, CLICK_PLATFORM_LABELS } from '@/lib/config'

type Limits = Record<
  string,
  {
    limit: number
    windowMs: number
    enabled: boolean
    retireEnabled: boolean
    harvestEnabled: boolean
  }
>

// Quota options (links per window). 0 = unlimited.
const LIMIT_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100]
// Wait-window options (the rolling time the quota applies over).
const WINDOW_OPTIONS: { ms: number; label: string }[] = [
  { ms: 15 * 60 * 1000, label: '15 minutes' },
  { ms: 30 * 60 * 1000, label: '30 minutes' },
  { ms: 60 * 60 * 1000, label: '1 hour' },
  { ms: 2 * 60 * 60 * 1000, label: '2 hours' },
  { ms: 3 * 60 * 60 * 1000, label: '3 hours' },
  { ms: 6 * 60 * 60 * 1000, label: '6 hours' },
  { ms: 12 * 60 * 60 * 1000, label: '12 hours' },
  { ms: 24 * 60 * 60 * 1000, label: '24 hours' },
]

// Admin panel: set each platform's hourly link quota + the wait window it applies
// over, and switch enforcement on/off PER PLATFORM.
//
// THREE INDEPENDENT RULES, each with its own per-platform switch. There is no
// master switch — every platform is governed entirely by its own row:
//   • Hourly  — that platform's hourly link quota.
//   • Retire  — link retirement for that platform (a link leaving the pool once
//     enough distinct users have clicked it).
//   • Harvest — automatic extraction of NEW videos from that platform's
//     channels, the pipeline's harvest stage. Off means its channels are never
//     visited; links already in the pool are unaffected.
// Saves immediately on change.
export default function PlatformLimits() {
  const [open, setOpen] = useState(false)
  const [limits, setLimits] = useState<Limits | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || limits) return
    fetch('/api/admin/limits')
      .then((r) => r.json())
      .then((d) => {
        if (d?.limits) setLimits(d.limits)
        else setError(d?.error || 'Could not load limits.')
      })
      .catch(() => setError('Could not load limits.'))
  }, [open, limits])

  // Flip one of a platform's two switches ('enabled' = hourly quota,
  // 'retireEnabled' = link retirement), independently of every other switch.
  async function savePlatformFlag(
    platform: string,
    flag: 'enabled' | 'retireEnabled' | 'harvestEnabled',
    next: boolean
  ) {
    setSavingKey(platform)
    setError('')
    const prev = limits?.[platform]
    // Optimistic: the row reflects the new state before the round-trip lands.
    if (prev) setLimits((l) => ({ ...(l || {}), [platform]: { ...prev, [flag]: next } }))
    try {
      const res = await fetch('/api/admin/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, [flag]: next }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d?.error || 'Could not save.')
        if (prev) setLimits((l) => ({ ...(l || {}), [platform]: prev })) // revert
      } else if (d?.limits) {
        setLimits(d.limits)
      }
    } catch {
      setError('Network error while saving.')
      if (prev) setLimits((l) => ({ ...(l || {}), [platform]: prev })) // revert
    } finally {
      setSavingKey(null)
    }
  }

  async function save(
    platform: string,
    next: {
      limit: number
      windowMs: number
      enabled: boolean
      retireEnabled: boolean
      harvestEnabled: boolean
    }
  ) {
    setSavingKey(platform)
    setError('')
    // Optimistic update.
    setLimits((prev) => ({ ...(prev || {}), [platform]: next }))
    try {
      const res = await fetch('/api/admin/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, limit: next.limit, windowMs: next.windowMs }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d?.error || 'Could not save.')
      } else if (d?.limits) {
        setLimits(d.limits)
      }
    } catch {
      setError('Network error while saving.')
    } finally {
      setSavingKey(null)
    }
  }

  // Ensure a dropdown always shows the current value even if it's a custom one
  // not in the option list.
  const limitOptionsFor = (v: number) =>
    LIMIT_OPTIONS.includes(v) ? LIMIT_OPTIONS : [...LIMIT_OPTIONS, v].sort((a, b) => a - b)
  const windowOptionsFor = (ms: number) =>
    WINDOW_OPTIONS.some((o) => o.ms === ms)
      ? WINDOW_OPTIONS
      : [...WINDOW_OPTIONS, { ms, label: `${Math.round(ms / 60000)} min` }].sort((a, b) => a.ms - b.ms)

  const selectCls =
    'bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500'

  // Platforms whose hourly quota is currently enforced (their own switch, with a
  // real cap set). Drives the header badge.
  const cappedCount = CLICK_PLATFORMS.filter((p) => {
    const r = limits?.[p]
    return r ? r.enabled && r.limit > 0 : false
  }).length
  // Platforms where retirement is live.
  const retiringCount = CLICK_PLATFORMS.filter((p) => limits?.[p]?.retireEnabled).length
  // Platforms the automatic channel extraction may visit.
  const harvestCount = CLICK_PLATFORMS.filter((p) => limits?.[p]?.harvestEnabled).length

  return (
    <div className="border border-zinc-800 rounded-xl bg-zinc-900/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-zinc-200">
          ⏱️ Link limits per platform
          <span className="text-zinc-500 font-normal">
            {' '}— hourly quota, wait time, retirement &amp; auto extraction
          </span>
          {open && (
            // Counts the platforms whose HOURLY quota is on. The master switch is
            // about retirement, so it would be the wrong thing to show here.
            <span
              className={`ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                cappedCount > 0
                  ? 'text-emerald-200 bg-emerald-500/15 border-emerald-500/40'
                  : 'text-zinc-400 bg-zinc-700/30 border-zinc-700'
              }`}
              title="How many platforms currently have their hourly quota enforced"
            >
              {cappedCount > 0 ? `${cappedCount}/${CLICK_PLATFORMS.length} CAPPED` : 'ALL UNCAPPED'}
            </span>
          )}
          {open && (
            <span
              className={`ml-1 text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                retiringCount > 0
                  ? 'text-amber-200 bg-amber-500/15 border-amber-500/40'
                  : 'text-zinc-400 bg-zinc-700/30 border-zinc-700'
              }`}
              title="How many platforms currently retire their links"
            >
              {retiringCount > 0 ? `${retiringCount}/${CLICK_PLATFORMS.length} RETIRING` : 'NO RETIRE'}
            </span>
          )}
          {open && (
            <span
              className={`ml-1 text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                harvestCount > 0
                  ? 'text-sky-200 bg-sky-500/15 border-sky-500/40'
                  : 'text-zinc-400 bg-zinc-700/30 border-zinc-700'
              }`}
              title="How many platforms the automatic channel extraction may visit"
            >
              {harvestCount > 0
                ? `${harvestCount}/${CLICK_PLATFORMS.length} HARVESTING`
                : 'NO HARVEST'}
            </span>
          )}
        </span>
        <span className={`text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-500 mb-3">
            Each user may open up to the <span className="text-zinc-300">quota</span> number of links on a
            platform within its <span className="text-zinc-300">wait window</span>. When they hit it, that
            platform locks until the oldest click ages out. Set <span className="text-zinc-300">Unlimited</span>{' '}
            to remove the cap. Each platform has its own <span className="text-zinc-300">Enforce</span>{' '}
            switch, so you can cap one platform and leave the others open. The{' '}
            <span className="text-zinc-300">Retire</span> switch is separate and independent: it controls
            whether that platform’s links leave everyone’s pool once enough distinct users have clicked
            them. The <span className="text-zinc-300">Harvest</span> switch is separate again: it
            controls whether the pipeline automatically looks at that platform’s channels for videos
            we have never seen. Off, its channels are never visited — no new links arrive by
            themselves — while everything already in the pool keeps being served exactly as before.
            Turning one switch off never affects the others, and there is no global switch — each
            platform stands alone.
          </p>
          <p className="text-xs text-zinc-600 mb-3">
            YouTube Shorts and YouTube Videos share their channels: a channel’s uploads are both, and
            which a new upload is cannot be known before it is fetched. So YouTube channels are
            visited while <em>either</em> of those two Harvest switches is on.
          </p>

          {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

          {!limits ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : (
            <div className="space-y-2">
              <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-3 px-1 text-[11px] uppercase tracking-wide text-zinc-500">
                <span>Platform</span>
                <span className="text-right" title="Enforce this platform's hourly link quota">Hourly</span>
                <span className="text-right" title="Retire this platform's links once enough distinct users have clicked them">Retire</span>
                <span className="text-right" title="Automatically extract new videos from this platform's channels">Harvest</span>
                <span className="text-right">Quota (links)</span>
                <span className="text-right">Wait window</span>
              </div>
              {CLICK_PLATFORMS.map((p) => {
                const cur = limits[p] ?? {
                  limit: 20,
                  windowMs: 60 * 60 * 1000,
                  enabled: true,
                  retireEnabled: true,
                  harvestEnabled: true,
                }
                // The hourly quota is live purely on this platform's own switch.
                const live = cur.enabled
                // Retirement is this platform's switch alone.
                const retiring = cur.retireEnabled
                const busy = savingKey === p
                return (
                  <div
                    key={p}
                    className={`grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto_auto_auto] items-center gap-2 sm:gap-3 rounded-lg border border-zinc-800 p-2 ${
                      cur.enabled || retiring || cur.harvestEnabled ? '' : 'opacity-60'
                    }`}
                  >
                    <span className="text-sm text-zinc-200">
                      {CLICK_PLATFORM_LABELS[p] || p}
                      {busy && <span className="text-xs text-zinc-500"> · saving…</span>}
                      {!busy && (
                        <>
                          <span
                            className={`ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                              live
                                ? 'text-emerald-200 bg-emerald-500/15 border-emerald-500/40'
                                : 'text-zinc-400 bg-zinc-700/30 border-zinc-700'
                            }`}
                            title={
                              live
                                ? 'This platform’s hourly quota is being enforced right now.'
                                : 'Switched off — this platform has no hourly link limit.'
                            }
                          >
                            {live ? 'HOURLY' : 'NO CAP'}
                          </span>
                          <span
                            className={`ml-1 text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                              retiring
                                ? 'text-amber-200 bg-amber-500/15 border-amber-500/40'
                                : 'text-zinc-400 bg-zinc-700/30 border-zinc-700'
                            }`}
                            title={
                              retiring
                                ? 'This platform’s links retire once enough distinct users have clicked them.'
                                : 'Switched off — this platform’s links never retire.'
                            }
                          >
                            {retiring ? 'RETIRES' : 'NO RETIRE'}
                          </span>
                          <span
                            className={`ml-1 text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                              cur.harvestEnabled
                                ? 'text-sky-200 bg-sky-500/15 border-sky-500/40'
                                : 'text-zinc-400 bg-zinc-700/30 border-zinc-700'
                            }`}
                            title={
                              cur.harvestEnabled
                                ? 'New videos are extracted from this platform’s channels automatically.'
                                : 'Switched off — this platform’s channels are never visited for new videos.'
                            }
                          >
                            {cur.harvestEnabled ? 'HARVESTS' : 'NO HARVEST'}
                          </span>
                        </>
                      )}
                    </span>
                    {/* Hourly-quota switch — independent of every other switch. */}
                    <button
                      type="button"
                      role="switch"
                      aria-label={`Enforce the hourly quota on ${CLICK_PLATFORM_LABELS[p] || p}`}
                      title="Enforce this platform's hourly link quota"
                      aria-checked={cur.enabled}
                      disabled={busy}
                      onClick={() => savePlatformFlag(p, 'enabled', !cur.enabled)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                        cur.enabled ? 'bg-emerald-600' : 'bg-zinc-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                          cur.enabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                    {/* Retirement switch — still gated by the master switch above. */}
                    <button
                      type="button"
                      role="switch"
                      aria-label={`Retire links on ${CLICK_PLATFORM_LABELS[p] || p}`}
                      title="Retire this platform's links once enough distinct users have clicked them"
                      aria-checked={cur.retireEnabled}
                      disabled={busy}
                      onClick={() => savePlatformFlag(p, 'retireEnabled', !cur.retireEnabled)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                        cur.retireEnabled ? 'bg-amber-600' : 'bg-zinc-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                          cur.retireEnabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                    {/* Automatic channel extraction — independent of both other
                        switches. Off, the pipeline's harvest stage never visits
                        this platform's channels; the pool is untouched. */}
                    <button
                      type="button"
                      role="switch"
                      aria-label={`Automatically extract new videos from ${CLICK_PLATFORM_LABELS[p] || p} channels`}
                      title="Automatically extract new videos from this platform's channels"
                      aria-checked={cur.harvestEnabled}
                      disabled={busy}
                      onClick={() => savePlatformFlag(p, 'harvestEnabled', !cur.harvestEnabled)}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                        cur.harvestEnabled ? 'bg-sky-600' : 'bg-zinc-600'
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                          cur.harvestEnabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                    <select
                      className={selectCls}
                      value={cur.limit}
                      disabled={busy || !cur.enabled}
                      onChange={(e) => save(p, { ...cur, limit: Number(e.target.value) })}
                    >
                      {limitOptionsFor(cur.limit).map((n) => (
                        <option key={n} value={n}>
                          {n === 0 ? 'Unlimited' : `${n} links`}
                        </option>
                      ))}
                    </select>
                    <select
                      className={selectCls}
                      value={cur.windowMs}
                      disabled={busy || !cur.enabled}
                      onChange={(e) => save(p, { ...cur, windowMs: Number(e.target.value) })}
                    >
                      {windowOptionsFor(cur.windowMs).map((o) => (
                        <option key={o.ms} value={o.ms}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
