'use client'

import { useEffect, useState } from 'react'

/**
 * The thresholds the automatic check blocks people on.
 *
 * WHY THESE ARE ON THE PAGE. They are judgements about somebody's account, made
 * nightly, and they were constants in the source — so changing one meant a
 * deploy. Worse, the only adjustable one was a field on the manual sweep that the
 * cron and the per-user button both ignored, so three callers ran three different
 * rules and nothing said so.
 *
 * Each field says what it does to a person, not what it does to a number: a
 * setting whose effect you have to derive is a setting nobody touches on purpose.
 */
interface Rules {
  on: boolean
  sample: number
  ratioSample: number
  ratioMinPct: number
  genreMinPct: number
  genreSample: number
}
interface Bound {
  min: number
  max: number
}
interface Bounds {
  sample: Bound
  ratioSample: Bound
  ratioMinPct: Bound
  genreMinPct: Bound
  genreSample: Bound
}

export default function BlockRules() {
  const [rules, setRules] = useState<Rules | null>(null)
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const [draft, setDraft] = useState({
    sample: '', ratioSample: '', ratioMinPct: '', genreMinPct: '', genreSample: '',
  })
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    let live = true
    fetch('/api/admin/block-rules')
      .then((r) => r.json())
      .then((d) => {
        if (!live || d?.error) return
        setRules(d.rules)
        setBounds(d.bounds)
        setDraft({
          sample: String(d.rules.sample),
          ratioSample: String(d.rules.ratioSample),
          ratioMinPct: String(d.rules.ratioMinPct),
          genreMinPct: String(d.rules.genreMinPct),
          genreSample: String(d.rules.genreSample),
        })
      })
      .catch(() => live && setErr('Could not read the block rules.'))
    return () => {
      live = false
    }
  }, [])

  async function save(patch: Partial<Rules>) {
    setBusy(true)
    setErr('')
    setNote('')
    try {
      const res = await fetch('/api/admin/block-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d?.error) {
        setErr(d?.error || 'Could not save.')
        return
      }
      setRules(d.rules)
      // Show what STUCK, not what was typed: 500 becomes 300 and the box has to
      // say so, or the next person believes the rule is running on 500.
      setDraft({
        sample: String(d.rules.sample),
        ratioSample: String(d.rules.ratioSample),
        ratioMinPct: String(d.rules.ratioMinPct),
        genreMinPct: String(d.rules.genreMinPct),
        genreSample: String(d.rules.genreSample),
      })
      setNote('Saved — the next check uses this.')
    } finally {
      setBusy(false)
    }
  }

  if (err && !rules) return <div className="text-xs text-rose-300">{err}</div>
  if (!rules || !bounds) return <div className="text-xs text-zinc-600">Loading block rules…</div>

  const num = (k: keyof typeof draft) => Number(draft[k])
  const changed =
    num('sample') !== rules.sample ||
    num('ratioSample') !== rules.ratioSample ||
    num('ratioMinPct') !== rules.ratioMinPct ||
    num('genreMinPct') !== rules.genreMinPct ||
    num('genreSample') !== rules.genreSample

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-white">🤖 Auto-block rules</div>
        <span
          className={`text-[11px] rounded px-1.5 py-0.5 border ${
            rules.on
              ? 'text-amber-200 bg-amber-600/15 border-amber-500/40'
              : 'text-zinc-400 bg-zinc-800 border-zinc-700'
          }`}
        >
          {rules.on ? 'on' : 'off — nothing blocks anybody'}
        </span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => void save({ on: !rules.on })}
          disabled={busy}
          title={
            rules.on
              ? 'Stop every automatic block: the nightly check, the sweep and the verify button all keep scoring and none of them blocks.'
              : 'Let the checks block again, on the rules below.'
          }
          className={`text-xs rounded-lg px-3 py-1.5 border transition-colors ${
            rules.on
              ? 'text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border-zinc-700'
              : 'text-white bg-emerald-600 hover:bg-emerald-500 border-emerald-500'
          } disabled:opacity-50`}
        >
          {rules.on ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      <p className="text-[11px] text-zinc-500 mt-1.5">
        A user is blocked when rule 1 or 2 holds — unless rule 3 finds a genre they do comment
        on, in which case only their weak genres are paused. Unreadable links count toward neither — a
        video that will not load is not a missing comment. Every block is reversible from the
        user&apos;s row, and unblocking re-arms the check.
      </p>

      <div className="mt-3 space-y-2.5">
        {/* RULE ONE. */}
        <label className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-zinc-300">
          <span className="text-zinc-500">1.</span>
          <span>Nothing found on</span>
          <input
            type="number"
            inputMode="numeric"
            min={bounds.sample.min}
            max={bounds.sample.max}
            step={5}
            value={draft.sample}
            onChange={(e) => setDraft({ ...draft, sample: e.target.value })}
            disabled={busy || !rules.on}
            className="w-16 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-zinc-100 tabular-nums disabled:opacity-50"
          />
          <span>judged links</span>
          <span className="text-[11px] text-zinc-600">
            ({bounds.sample.min}–{bounds.sample.max}; one comment found anywhere stops it)
          </span>
        </label>

        {/* RULE TWO. */}
        <label className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-zinc-300">
          <span className="text-zinc-500">2.</span>
          <span>Under</span>
          <input
            type="number"
            inputMode="numeric"
            min={bounds.ratioMinPct.min}
            max={bounds.ratioMinPct.max}
            value={draft.ratioMinPct}
            onChange={(e) => setDraft({ ...draft, ratioMinPct: e.target.value })}
            disabled={busy || !rules.on}
            className="w-14 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-zinc-100 tabular-nums disabled:opacity-50"
          />
          <span>% of their last</span>
          <input
            type="number"
            inputMode="numeric"
            min={bounds.ratioSample.min}
            max={bounds.ratioSample.max}
            step={10}
            value={draft.ratioSample}
            onChange={(e) => setDraft({ ...draft, ratioSample: e.target.value })}
            disabled={busy || !rules.on}
            className="w-16 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-zinc-100 tabular-nums disabled:opacity-50"
          />
          <span>judged links carry a comment</span>
          <span className="text-[11px] text-zinc-600">
            ({bounds.ratioMinPct.min}–{bounds.ratioMinPct.max}% ·{' '}
            {bounds.ratioSample.min}–{bounds.ratioSample.max} links)
          </span>
        </label>

        {/* RULE THREE: by genre. */}
        <label className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-zinc-300">
          <span className="text-zinc-500">3.</span>
          <span>By genre: a genre under</span>
          <input
            type="number"
            inputMode="numeric"
            min={bounds.genreMinPct.min}
            max={bounds.genreMinPct.max}
            value={draft.genreMinPct}
            onChange={(e) => setDraft({ ...draft, genreMinPct: e.target.value })}
            disabled={busy || !rules.on}
            className="w-14 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-zinc-100 tabular-nums disabled:opacity-50"
          />
          <span>% average over at least</span>
          <input
            type="number"
            inputMode="numeric"
            min={bounds.genreSample.min}
            max={bounds.genreSample.max}
            step={10}
            value={draft.genreSample}
            onChange={(e) => setDraft({ ...draft, genreSample: e.target.value })}
            disabled={busy || !rules.on}
            className="w-16 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-zinc-100 tabular-nums disabled:opacity-50"
          />
          <span>judged links stops being served to them; under it in every genre blocks them</span>
          <span className="text-[11px] text-zinc-600">
            ({bounds.genreMinPct.min}–{bounds.genreMinPct.max}% ·{' '}
            {bounds.genreSample.min}–{bounds.genreSample.max} links · a paused genre is lifted from
            the user&apos;s ⏸ chip)
          </span>
        </label>
      </div>

      {/* WHAT THE NUMBERS MEAN FOR REAL PEOPLE. Measured when the rate rule was
          added: eight workers sat at 0–8% and everyone else started at 11%, so a
          threshold in that gap separates two groups that were already separate.
          Above it the rule starts on the median worker, who is around 20%. */}
      <p className="text-[11px] text-zinc-600 mt-2.5">
        For scale: on the last measurement, workers who were doing the job ran 11–36% and the
        ones who were not sat at 0–8%. A threshold above about 10% starts blocking people who
        are working; below 200 links the rate is noisier than the difference it is measuring.
      </p>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          type="button"
          onClick={() =>
            void save({
              sample: num('sample'),
              ratioSample: num('ratioSample'),
              ratioMinPct: num('ratioMinPct'),
              genreMinPct: num('genreMinPct'),
              genreSample: num('genreSample'),
            })
          }
          disabled={busy || !changed}
          className="text-xs text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1.5 disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save rules'}
        </button>
        <span className="text-[11px] text-zinc-500">
          Now: {rules.on ? '' : 'OFF · '}nothing on {rules.sample}, or under {rules.ratioMinPct}%
          of {rules.ratioSample}; per genre under {rules.genreMinPct}% of {rules.genreSample}
        </span>
        {note && <span className="text-[11px] text-emerald-400">{note}</span>}
        {err && <span className="text-[11px] text-rose-300">{err}</span>}
      </div>
    </div>
  )
}
