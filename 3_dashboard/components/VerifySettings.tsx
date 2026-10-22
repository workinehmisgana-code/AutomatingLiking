'use client'

import { useEffect, useState } from 'react'

/**
 * Admin card: the account-age gate's two settings.
 *
 * THE FLOOR IS A JUDGEMENT, not a fact about the code. How old an account has
 * to be before its comments are worth paying for depends on how many
 * day-old accounts are turning up this month, and the person watching that is
 * the one who should be able to move the number — without a deploy, and
 * without editing anything.
 *
 * THE VIDEO HAS TO BE ROTATABLE for a reason that is easy to miss: TikTok
 * returns a video's comments RANKED and only a few hundred deep. Every worker
 * comments on the same video, so once it is busy a new worker's comment stops
 * being findable and "not found" starts holding honest people. Pointing this
 * at a fresh video fixes it, and each worker's record remembers which video
 * they were checked against, so nobody already through is disturbed.
 */
export default function VerifySettings() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [days, setDays] = useState('')
  const [video, setVideo] = useState('')
  const [info, setInfo] = useState<{
    gateEnabled: boolean
    defaultMinAgeDays: number
    floor: number
    ceiling: number
  } | null>(null)

  useEffect(() => {
    if (!open || !loading) return
    fetch('/api/admin/verify-settings')
      .then((r) => r.json())
      .then((d) => {
        if (d?.error) return setErr(d.error)
        setDays(String(d.minAgeDays ?? ''))
        setVideo(String(d.videoUrl ?? ''))
        setInfo({
          gateEnabled: !!d.gateEnabled,
          defaultMinAgeDays: Number(d.defaultMinAgeDays ?? 90),
          floor: Number(d.floor ?? 0),
          ceiling: Number(d.ceiling ?? 3650),
        })
      })
      .catch(() => setErr('Could not load the verification settings.'))
      .finally(() => setLoading(false))
  }, [open, loading])

  async function save(body: Record<string, unknown>, what: string) {
    setSaving(true)
    setErr('')
    setNote('')
    try {
      const res = await fetch('/api/admin/verify-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(d?.error || `Could not save the ${what}.`)
        return
      }
      setDays(String(d.minAgeDays ?? ''))
      setVideo(String(d.videoUrl ?? ''))
      setNote(`Saved the ${what}.`)
    } catch {
      setErr('Could not reach the server.')
    } finally {
      setSaving(false)
    }
  }

  const months = Number(days) > 0 ? (Number(days) / 30).toFixed(1) : ''

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="text-sm font-semibold text-white">🪪 Account age gate</span>
        <span className="text-[11px] text-zinc-500">
          {info && !info.gateEnabled ? 'not enforced · ' : ''}
          {open ? 'hide' : 'show'}
        </span>
      </button>

      {open && (
        <div className="mt-3">
          {loading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : (
            <>
              {/* Whether any of this is in force at all. Setting a floor on a
                  gate that is switched off reads as having done something. */}
              {info && !info.gateEnabled && (
                <p className="text-xs text-amber-300/90 mb-3 leading-relaxed">
                  The gate is <b>off</b> — these settings are stored but nothing is being
                  held. Set <code className="text-amber-200">VERIFY_GATE_ENABLED=true</code> in
                  the environment to enforce it.
                </p>
              )}

              <label className="block text-[11px] uppercase tracking-wide text-zinc-500 mb-1">
                Minimum account age
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  value={days}
                  min={info?.floor ?? 0}
                  max={info?.ceiling ?? 3650}
                  onChange={(e) => setDays(e.target.value)}
                  className="w-28 bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white tabular-nums focus:outline-none focus:border-emerald-500"
                />
                <span className="text-xs text-zinc-500">
                  days{months ? ` · about ${months} months` : ''}
                </span>
                <button
                  onClick={() => save({ minAgeDays: Number(days) }, 'minimum age')}
                  disabled={saving}
                  className="text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors"
                >
                  Save
                </button>
              </div>
              <p className="text-[11px] text-zinc-600 mt-1.5 leading-relaxed">
                An account younger than this is refused. {info?.defaultMinAgeDays ?? 90} days is
                the default. 0 lets every account through, which switches the age test off while
                leaving the comment check on.
              </p>

              <label className="block text-[11px] uppercase tracking-wide text-zinc-500 mt-4 mb-1">
                Verification video
              </label>
              <input
                type="text"
                value={video}
                onChange={(e) => setVideo(e.target.value)}
                spellCheck={false}
                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
              />
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => save({ videoUrl: video }, 'video')}
                  disabled={saving}
                  className="text-xs text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors"
                >
                  Save
                </button>
                <a
                  href={video}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-zinc-400 hover:text-white underline"
                >
                  Open it
                </a>
              </div>
              <p className="text-[11px] text-zinc-600 mt-1.5 leading-relaxed">
                Workers comment on this video to prove the account is theirs. TikTok returns a
                video&apos;s comments ranked and only a few hundred deep, so once this one is busy
                a new worker&apos;s comment stops being findable — point it at a fresh video then.
                Anyone already verified stays verified.
              </p>

              {err && <p className="text-xs text-rose-300 mt-3">{err}</p>}
              {note && <p className="text-xs text-emerald-300 mt-3">{note}</p>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
