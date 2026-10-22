'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'

/**
 * Solve the liker's captchas from a phone, from anywhere.
 *
 * The liker runs headless at home. When TikTok puts a puzzle in front of an
 * account the run stops: the comment list renders as grey placeholders and the
 * account is skipped for the rest of the pass. Somebody has to drag a slider,
 * and until now that somebody had to be sitting at that machine.
 *
 * So the worker posts the puzzle to /api/captcha and polls for the answer, and
 * this page — already on the internet, already behind the admin login — is where
 * the answer comes from. No tunnel, no port forwarding, no opening the liker's
 * own control panel to the world.
 *
 * TWO KINDS OF PUZZLE, two ways to answer:
 *
 *   rotate  the disc-and-annulus one. The two images TikTok sent are composited
 *           here and the inner disc really turns under the slider, so this is
 *           the same judgement as dragging the real thing — not a guess at a
 *           number. One angle goes back.
 *
 *   other   anything else ("pick the two matching shapes"). A screenshot of the
 *           widget is shown and taps come back as FRACTIONS of it, because the
 *           picture is scaled to whatever phone is looking at it.
 */
interface Req {
  id: string
  profile: string
  kind: string
  instruction: string
  outer: string | null
  inner: string | null
  shot: string | null
  boxW: number | null
  boxH: number | null
  answer: unknown | null
  createdAt: string
  answeredAt: string | null
}

const POLL_MS = 2000

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  return `${Math.floor(s / 60)}m ${s % 60}s ago`
}

export default function RemoteCaptcha() {
  const [reqs, setReqs] = useState<Req[]>([])
  const [err, setErr] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [alerts, setAlerts] = useState(false)
  const [sending, setSending] = useState('')
  const [sent, setSent] = useState<Record<string, string>>({})
  // Per-card state, keyed by request id so two stuck accounts do not share one
  // slider.
  const [angle, setAngle] = useState<Record<string, number>>({})
  const [invert, setInvert] = useState<Record<string, boolean>>({})
  const [taps, setTaps] = useState<Record<string, [number, number][]>>({})
  // Each image's natural width, recorded as it loads, so the inner disc can be
  // drawn at its true size relative to the outer one. Two widths rather than one
  // computed ratio because they load in whichever order the network decides, and
  // a ratio worked out on the first load would be a ratio against nothing.
  const [natural, setNatural] = useState<Record<string, number>>({})

  const seen = useRef<Set<string>>(new Set())
  const audio = useRef<AudioContext | null>(null)

  /** navigator.vibrate is real on phones and absent from the DOM types. */
  const buzz = (pattern: number | number[]) => {
    try {
      const n = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }
      n.vibrate?.(pattern)
    } catch {
      /* a phone that will not buzz still beeps */
    }
  }

  /** A short double beep. Built here so there is no asset to ship or load. */
  const beep = useCallback(() => {
    try {
      const ctx =
        audio.current ??
        new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
      audio.current = ctx
      if (ctx.state === 'suspended') void ctx.resume()
      for (const [at, hz] of [[0, 880], [0.18, 1180]] as const) {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.frequency.value = hz
        o.connect(g)
        g.connect(ctx.destination)
        g.gain.setValueAtTime(0.0001, ctx.currentTime + at)
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.15)
        o.start(ctx.currentTime + at)
        o.stop(ctx.currentTime + at + 0.16)
      }
    } catch {
      /* a page that cannot beep is still a page that works */
    }
  }, [])

  /**
   * Ask for permission and unlock sound, which needs a real tap to do.
   *
   * Browsers refuse both from a page the person has not touched, and a phone in
   * a pocket is exactly the case this page exists for — so the button is the
   * first thing on it.
   */
  async function enableAlerts() {
    try {
      if ('Notification' in window && Notification.permission === 'default') {
        await Notification.requestPermission()
      }
    } catch {
      /* ignore */
    }
    beep()
    buzz(60)
    setAlerts(true)
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/captcha', { cache: 'no-store' })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? 'Failed')
      const rows: Req[] = Array.isArray(d?.requests) ? d.requests : []
      setReqs(rows)
      setErr('')
      // Anything new and still unanswered is worth making a noise about.
      for (const r of rows) {
        if (seen.current.has(r.id)) continue
        seen.current.add(r.id)
        if (r.answer) continue
        beep()
        buzz([120, 60, 120])
        try {
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`Captcha: profile ${r.profile}`, {
              body: r.instruction || 'A run is waiting for you.',
              tag: r.id,
            })
          }
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setErr(String(e))
    }
  }, [beep])

  useEffect(() => {
    void load()
    const t = setInterval(() => {
      void load()
      setNow(Date.now())
    }, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  async function send(id: string, answer: Record<string, unknown>, label: string) {
    setSending(id)
    try {
      const res = await fetch('/api/admin/captcha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...answer }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? 'Failed')
      setSent((s) => ({ ...s, [id]: label }))
      await load()
    } catch (e) {
      setErr(String(e))
    } finally {
      setSending('')
    }
  }

  const open = reqs.filter((r) => !r.answer)

  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-zinc-100">
      <div className="max-w-xl mx-auto px-3 py-4 sm:px-4 sm:py-6">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h1 className="text-lg sm:text-xl font-bold">
            Captcha
            {/* A relay for the phone's captchas: nothing here belongs to a genre. */}
            <span className="text-[11px] font-normal text-zinc-500"> · all genres</span>
          </h1>
          <Link
            href="/admin"
            className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5"
          >
            ← Admin
          </Link>
        </div>
        <p className="text-xs text-zinc-500 leading-relaxed mb-3">
          When the liker meets a puzzle it stops and posts it here. Answer it from
          this page and the run carries on — it does not matter which network you
          are on.
        </p>

        {!alerts && (
          <button
            onClick={enableAlerts}
            className="w-full mb-3 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl px-4 py-3"
          >
            🔔 Turn on sound and alerts
          </button>
        )}
        {alerts && (
          <p className="text-[11px] text-emerald-400/80 mb-3">
            Alerts on. Keep this tab open — it checks every {POLL_MS / 1000}s and
            will beep and buzz when an account gets stuck.
          </p>
        )}
        {err && (
          <p className="text-xs text-red-400 mb-3 break-words">{err}</p>
        )}

        {open.length === 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-center">
            <p className="text-sm text-zinc-400">Nothing stuck right now.</p>
            <p className="text-[11px] text-zinc-600 mt-1">
              A puzzle shows up here within a second or two of a run hitting one.
            </p>
          </div>
        )}

        <div className="space-y-4">
          {open.map((r) => {
            const a = angle[r.id] ?? 0
            // Until both images have reported a width, the disc is drawn at half
            // the outer image — visibly provisional rather than wrong.
            const ow = natural[`outer:${r.id}`] ?? 0
            const iw = natural[`inner:${r.id}`] ?? 0
            const rt = ow > 0 && iw > 0 ? Math.min(1, iw / ow) : 0.5
            const pts = taps[r.id] ?? []
            const busy = sending === r.id
            const rotate = r.kind === 'rotate' && r.outer && r.inner
            return (
              <div
                key={r.id}
                className="rounded-xl border border-amber-700/50 bg-amber-950/10 overflow-hidden"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2 border-b border-zinc-800">
                  <span className="text-sm font-semibold text-white">
                    profile {r.profile}
                  </span>
                  <span className="text-[11px] text-zinc-500">{r.kind}</span>
                  <span className="text-[11px] text-zinc-600 ml-auto">
                    {ago(r.createdAt, now)}
                  </span>
                </div>
                {r.instruction && (
                  <p className="px-3 pt-2 text-[11px] text-zinc-400 leading-relaxed">
                    {r.instruction}
                  </p>
                )}

                {rotate ? (
                  <div className="p-3">
                    {/* The real widget, composited. The outer image sets the
                        size; the inner disc sits centred on it and turns with
                        the slider, so lining it up here is the same act as
                        lining it up there. */}
                    <div className="relative mx-auto w-full max-w-[320px] select-none">
                      <img
                        src={`data:image/png;base64,${r.outer}`}
                        alt="puzzle"
                        className="block w-full rounded-lg"
                        onLoad={(e) => {
                          const w = e.currentTarget.naturalWidth || 1
                          setNatural((s) => ({ ...s, [`outer:${r.id}`]: w }))
                        }}
                      />
                      <img
                        src={`data:image/png;base64,${r.inner}`}
                        alt="disc"
                        style={{
                          width: `${rt * 100}%`,
                          transform: `translate(-50%, -50%) rotate(${
                            invert[r.id] ? -a : a
                          }deg)`,
                        }}
                        className="absolute left-1/2 top-1/2 origin-center"
                        onLoad={(e) => {
                          const w = e.currentTarget.naturalWidth || 1
                          setNatural((s) => ({ ...s, [`inner:${r.id}`]: w }))
                        }}
                      />
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                      <button
                        onClick={() =>
                          setAngle((s) => ({ ...s, [r.id]: ((a - 1) % 360 + 360) % 360 }))
                        }
                        className="shrink-0 w-10 h-10 rounded-lg border border-zinc-700 text-zinc-200 text-lg leading-none"
                        aria-label="one degree back"
                      >
                        −
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={359}
                        step={1}
                        value={a}
                        onChange={(e) =>
                          setAngle((s) => ({ ...s, [r.id]: Number(e.target.value) }))
                        }
                        className="flex-1 accent-emerald-500 h-10"
                      />
                      <button
                        onClick={() => setAngle((s) => ({ ...s, [r.id]: (a + 1) % 360 }))}
                        className="shrink-0 w-10 h-10 rounded-lg border border-zinc-700 text-zinc-200 text-lg leading-none"
                        aria-label="one degree on"
                      >
                        +
                      </button>
                      <span className="shrink-0 w-12 text-right text-sm tabular-nums text-zinc-300">
                        {a}°
                      </span>
                    </div>

                    <label
                      className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500"
                      title="If the disc here turns the opposite way to the real widget, this flips it. Nothing else about the answer changes."
                    >
                      <input
                        type="checkbox"
                        checked={!!invert[r.id]}
                        onChange={(e) =>
                          setInvert((s) => ({ ...s, [r.id]: e.target.checked }))
                        }
                        className="accent-emerald-500"
                      />
                      turns the wrong way
                    </label>

                    <button
                      onClick={() => send(r.id, { angle: a }, `sent ${a}°`)}
                      disabled={busy}
                      className="mt-3 w-full text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl px-4 py-3 disabled:opacity-50"
                    >
                      {busy ? 'Sending…' : `Send ${a}°`}
                    </button>
                  </div>
                ) : r.shot ? (
                  <div className="p-3">
                    {/* Taps, as fractions of the picture. The phone is showing
                        it at whatever width it has, so pixels here mean nothing
                        on the machine the browser is actually on. */}
                    <div className="relative mx-auto w-full max-w-[380px]">
                      <img
                        src={`data:image/png;base64,${r.shot}`}
                        alt="puzzle"
                        className="block w-full rounded-lg"
                        onClick={(e) => {
                          const box = e.currentTarget.getBoundingClientRect()
                          const x = (e.clientX - box.left) / box.width
                          const y = (e.clientY - box.top) / box.height
                          setTaps((s) => ({ ...s, [r.id]: [...(s[r.id] ?? []), [x, y]] }))
                        }}
                      />
                      {pts.map(([x, y], i) => (
                        <span
                          key={i}
                          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                          className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-emerald-500/80 text-[11px] font-bold text-black grid place-items-center pointer-events-none"
                        >
                          {i + 1}
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-zinc-500">
                        {pts.length === 0
                          ? 'Tap the picture where it should be tapped, in order.'
                          : `${pts.length} tap${pts.length === 1 ? '' : 's'}`}
                      </span>
                      {pts.length > 0 && (
                        <button
                          onClick={() => setTaps((s) => ({ ...s, [r.id]: [] }))}
                          className="text-[11px] text-zinc-400 border border-zinc-700 rounded-lg px-2 py-1"
                        >
                          clear
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() =>
                        send(r.id, { points: pts }, `sent ${pts.length} tap(s)`)
                      }
                      disabled={busy || pts.length === 0}
                      className="mt-3 w-full text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl px-4 py-3 disabled:opacity-40"
                    >
                      {busy ? 'Sending…' : 'Send taps'}
                    </button>
                  </div>
                ) : (
                  <p className="p-3 text-xs text-amber-400/80">
                    This puzzle arrived with no picture. Use <b>Different puzzle</b> to
                    ask TikTok for another one.
                  </p>
                )}

                <div className="flex gap-2 px-3 pb-3">
                  <button
                    onClick={() => send(r.id, { refresh: true }, 'asked for another')}
                    disabled={busy}
                    className="flex-1 text-xs text-zinc-200 border border-zinc-700 rounded-lg px-2 py-2 disabled:opacity-50"
                  >
                    Different puzzle
                  </button>
                  <button
                    onClick={() => send(r.id, { give_up: true }, 'skipped')}
                    disabled={busy}
                    className="flex-1 text-xs text-zinc-400 border border-zinc-800 rounded-lg px-2 py-2 disabled:opacity-50"
                    title="Stop waiting. This account is skipped for the rest of the run; the others carry on."
                  >
                    Skip this account
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Answered a moment ago, so pressing Submit does not simply make the
            card vanish — which reads as the answer having been lost. */}
        {reqs.some((r) => r.answer) && (
          <div className="mt-4 space-y-1">
            {reqs
              .filter((r) => r.answer)
              .map((r) => (
                <p key={r.id} className="text-[11px] text-zinc-600">
                  profile {r.profile}: {sent[r.id] ?? 'answered'} ·{' '}
                  {r.answeredAt ? ago(r.answeredAt, now) : ''} — waiting for the run to
                  pick it up
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
