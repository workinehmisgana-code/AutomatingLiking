'use client'

import { useCallback, useEffect, useState } from 'react'

interface Cycle {
  id: number
  startedAt: string
  finishedAt: string | null
  stages: Record<string, Record<string, unknown>>
}

interface CoverageRow {
  cluster: string
  compared: number
  lacked: number
  gained: number
  read: number
  withOurs: number
}

interface Coverage {
  laterAt: string
  earlierAt: string
  rank: CoverageRow[]
  date: CoverageRow[]
}

interface Payload {
  coverage: Coverage | null
  cycles: Cycle[]
  stage: string
  last: { stage: string; done: boolean; detail: Record<string, unknown>; at: string } | null
  timing: { startedAt: string | null; dueAt: string | null }
  everyHours: number
  /** The hourly recluster, which runs on its own schedule rather than as part
   *  of a lap — the cluster scores are relative, so they drift between laps. */
  recluster: { lastAt: string | null; dueAt: string | null; everyHours: number } | null
}

const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const fmt = (v: unknown) => n(v).toLocaleString()

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function took(a: string, b: string | null): string {
  if (!b) return 'running'
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (ms < 0) return '—'
  const min = Math.round(ms / 60000)
  return min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} h`
}

/** What each stage contributed, in the words that stage uses. */
function summarise(stage: string, d: Record<string, unknown>): string {
  if (!d || Object.keys(d).length === 0) return '—'
  switch (stage) {
    case 'harvest':
      return (
        `${fmt(d.checked)} of ${fmt(d.eligible)} eligible channel(s) · ` +
        `${fmt(d.found)} new video(s) · ` +
        `${fmt(d.merged)} merged · ${fmt(d.staged)} to verify` +
        (n(d.untitled) ? ` (${fmt(d.untitled)} untitled)` : '')
      )
    case 'extract':
      return `${fmt(d.read)} link(s) read · ${fmt(d.withOurs)} carry one of ours`
    case 'categorise':
      return `${fmt(d.processed)} link(s) sorted`
    case 'recluster':
      return `${fmt(d.scored)} of ${fmt(d.total)} link(s) rescored`
    default:
      return JSON.stringify(d).slice(0, 90)
  }
}

const STAGE_LABEL: Record<string, string> = {
  idle: 'waiting',
  harvest: '🌾 harvest',
  extract: '💬 extract',
  categorise: '🎯 categorise',
  recluster: '🧮 recluster',
}

/**
 * Did the links that had none of our comments last cycle gain one?
 *
 * Only links BOTH cycles read appear. A link the latest cycle has not reached
 * yet says nothing about whether a comment landed on it, and counting it as "not
 * gained" would report the scan's own progress as a failure to place comments.
 */
/** One figure, for a dimension reported as a whole rather than per cluster. */
function CoverageSummary({ row, title, note }: { row: CoverageRow; title: string; note: string }) {
  const pct = row.lacked > 0 ? Math.round((100 * row.gained) / row.lacked) : null
  const Cell = ({ label, value, tone }: { label: string; value: string; tone?: string }) => (
    <div>
      <div className={`text-lg tabular-nums ${tone ?? 'text-zinc-100'}`}>{value}</div>
      <div className="text-[11px] text-zinc-500">{label}</div>
    </div>
  )
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="px-4 py-3 border-b border-zinc-800">
        <div className="text-sm font-semibold text-white">{title}</div>
        <div className="text-xs text-zinc-500 mt-0.5">{note}</div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-4 py-3">
        <Cell label="links read" value={row.read.toLocaleString()} />
        <Cell label="carry one of ours" value={row.withOurs.toLocaleString()} />
        <Cell label="lacked ours last run" value={row.lacked.toLocaleString()} />
        <Cell
          label={pct === null ? 'gained one since' : `gained one since — ${pct}%`}
          value={row.gained.toLocaleString()}
          tone={row.gained > 0 ? 'text-emerald-400' : 'text-zinc-100'}
        />
      </div>
    </div>
  )
}

function CoverageTable({ rows, title, note }: { rows: CoverageRow[]; title: string; note: string }) {
  if (rows.length === 0) return null
  const sum = rows.reduce(
    (a, r) => ({
      compared: a.compared + r.compared,
      lacked: a.lacked + r.lacked,
      gained: a.gained + r.gained,
      read: a.read + r.read,
      withOurs: a.withOurs + r.withOurs,
    }),
    { compared: 0, lacked: 0, gained: 0, read: 0, withOurs: 0 }
  )
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : '—')

  const Row = ({ r, bold }: { r: CoverageRow & { cluster: string }; bold?: boolean }) => (
    <tr className={bold ? 'text-zinc-100 font-medium' : 'text-zinc-400'}>
      <td className="px-3 py-1.5 whitespace-nowrap">{r.cluster}</td>
      <td className="px-2 text-right tabular-nums">{r.read.toLocaleString()}</td>
      <td className="px-2 text-right tabular-nums">{r.withOurs.toLocaleString()}</td>
      <td className="px-2 text-right tabular-nums">{r.lacked.toLocaleString()}</td>
      <td className="px-2 text-right tabular-nums">
        <span className={r.gained > 0 ? 'text-emerald-400' : ''}>{r.gained.toLocaleString()}</span>
      </td>
      <td className="px-3 text-right tabular-nums text-zinc-500">{pct(r.gained, r.lacked)}</td>
    </tr>
  )

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="px-4 py-3 border-b border-zinc-800">
        <div className="text-sm font-semibold text-white">{title}</div>
        <div className="text-xs text-zinc-500 mt-0.5">{note}</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead>
            <tr className="text-[11px] text-zinc-500 border-b border-zinc-800">
              <th className="text-left font-normal px-3 py-1.5">cluster</th>
              <th className="text-right font-normal px-2">read now</th>
              <th className="text-right font-normal px-2">carry ours</th>
              <th className="text-right font-normal px-2">lacked before</th>
              <th className="text-right font-normal px-2">gained</th>
              <th className="text-right font-normal px-3">of those</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            <Row r={{ ...sum, cluster: 'all' }} bold />
            {rows.map((r) => (
              <Row key={r.cluster} r={r} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function PipelineReport() {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<number | null>(null)

  const load = useCallback(() => {
    fetch('/api/admin/pipeline')
      .then((r) => r.json())
      .then((d) => (d?.error ? setErr(d.error) : setData(d)))
      .catch((e) => setErr(String(e)))
  }, [])

  useEffect(() => {
    load()
    // The cycle moves on its own; refresh so an open report does not go stale.
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  if (err) return <p className="text-sm text-rose-300">{err}</p>
  if (!data) return <p className="text-sm text-zinc-500">Loading…</p>

  const running = data.cycles.find((c) => !c.finishedAt)

  return (
    <div className="space-y-4">
      {/* Where it is right now */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-semibold text-white">
            {STAGE_LABEL[data.stage] ?? data.stage}
            {data.stage === 'idle' ? '' : ' — running now'}
          </div>
          <div className="text-xs text-zinc-500">
            a cycle every {data.everyHours} hours
          </div>
        </div>
        <div className="text-xs text-zinc-400 mt-1">
          {data.stage === 'idle' ? (
            <>
              Next cycle {data.timing.dueAt ? when(data.timing.dueAt) : 'as soon as the scheduler runs'}
              {data.timing.startedAt && <> · last began {when(data.timing.startedAt)}</>}
            </>
          ) : (
            <>Started {when(data.timing.startedAt)}</>
          )}
        </div>
        {data.last && (
          <div className="text-[11px] text-zinc-600 mt-2">
            last tick {when(data.last.at)} · {data.last.stage}
            {data.last.done ? ' · finished that step' : ''}
          </div>
        )}
        {data.recluster && (
          <div
            className="text-[11px] text-zinc-500 mt-1"
            title="The posted-date score is relative to the whole pool, so it drifts as links are added and blocked. This rescores every link on its own schedule, separately from the cycle."
          >
            🧮 recluster every {data.recluster.everyHours}h ·{' '}
            {data.recluster.lastAt
              ? <>last {when(data.recluster.lastAt)} · next {when(data.recluster.dueAt)}</>
              : 'not run yet — the next scheduled hour does the first one'}
          </div>
        )}
      </div>

      {/* The question the whole cycle exists to answer. */}
      {data.coverage ? (
        <>
          {data.coverage.rank[0] && (
            <CoverageSummary
              row={data.coverage.rank[0]}
              title="Search-rank clusters, all together"
              note={`Comparing the run of ${when(data.coverage.laterAt)} against ${when(
                data.coverage.earlierAt
              )}. Only links BOTH runs read are counted.`}
            />
          )}
          <CoverageTable
            rows={data.coverage.date}
            title="Posted-date clusters, one by one"
            note="The top 3, which are the ones this cycle reads. A link can sit in a rank cluster and a date cluster at once, so this overlaps the figure above rather than adding to it."
          />
        </>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-6 text-center">
          <div className="text-sm text-zinc-400">Nothing to compare yet</div>
          <div className="text-xs text-zinc-600 mt-1">
            This needs two completed runs — the second one is what shows whether the links that
            lacked our comments have gained any.
          </div>
        </div>
      )}

      {data.cycles.length === 0 && (
        <p className="text-sm text-zinc-500 py-10 text-center">
          No cycles recorded yet. The first one starts as soon as the scheduler fires.
        </p>
      )}

      {/* Every turn it has taken */}
      {data.cycles.map((c) => {
        const isOpen = open === c.id
        const h = c.stages.harvest ?? {}
        const e = c.stages.extract ?? {}
        return (
          <div
            key={c.id}
            className={`rounded-xl border bg-zinc-900/40 ${
              c.finishedAt ? 'border-zinc-800' : 'border-emerald-600/50'
            }`}
          >
            <button
              onClick={() => setOpen(isOpen ? null : c.id)}
              className="w-full text-left px-4 py-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
            >
              <span className="text-sm text-zinc-200">
                {when(c.startedAt)}
                {!c.finishedAt && <span className="text-emerald-400"> · running</span>}
              </span>
              <span className="text-xs text-zinc-500">
                {fmt(h.found)} new · {fmt(h.merged)} merged · {fmt(e.read)} read ·{' '}
                {took(c.startedAt, c.finishedAt)}
              </span>
            </button>
            {isOpen && (
              <div className="border-t border-zinc-800 divide-y divide-zinc-800/60">
                {['harvest', 'extract', 'categorise', 'recluster'].map((s) => {
                  const d = c.stages[s]
                  return (
                    <div key={s} className="px-4 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-xs text-zinc-400 w-28 shrink-0">{STAGE_LABEL[s]}</span>
                      <span className="text-xs text-zinc-300 flex-1 min-w-0">
                        {d ? summarise(s, d) : <span className="text-zinc-600">not reached</span>}
                      </span>
                      {d && (
                        <span className="text-[11px] text-zinc-600 shrink-0">
                          {fmt(d.ticks)} tick(s)
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {running && (
        <p className="text-[11px] text-zinc-600">
          A cycle in progress shows the totals it has reached so far; they keep rising until it
          finishes.
        </p>
      )}
    </div>
  )
}
