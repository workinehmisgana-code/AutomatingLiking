'use client'

import { useEffect, useMemo, useState } from 'react'

/** One press of "Extract comments" that read something. */
interface ScanRun {
  id: number
  startedAt: string
  updatedAt: string
  links: number
  commentsRead: number
  ours: number
  linksWithOurs: number
  perProduct: Record<string, number>
}

interface Scope {
  key: string
  label: string
  runs: ScanRun[]
  scans: number
  latestAt: string
  latestOurs: number
  change: number | null
}

/** A line per product, plus the total. Distinct at a glance and colour-blind safe
 *  enough that the legend is not the only way to tell them apart. */
const LINE: Record<string, string> = {
  total: '#e4e4e7',
  purifytext: '#34d399',
  acoustictext: '#60a5fa',
  prohumanly: '#f472b6',
  humlexic: '#fbbf24',
  kinprose: '#a78bfa',
  tintfolio: '#fb923c',
}
const colourOf = (k: string) => LINE[k] ?? '#71717a'

function shortDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * How our comments on one set of links have moved from scan to scan.
 *
 * Plain inline SVG — it is a handful of polylines and the point is to see a
 * direction, not to interact with a chart library.
 */
function Trend({
  runs,
  products,
  show,
}: {
  runs: ScanRun[]
  products: string[]
  show: Set<string>
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (runs.length < 2) {
    return (
      <div className="px-4 py-8 text-center text-xs text-zinc-500">
        Only one scan of this selection so far. Press{' '}
        <span className="text-zinc-300">💬 Extract comments</span> again with the same filters and a
        trend appears here.
      </div>
    )
  }

  const W = 720
  const H = 200
  const PAD_X = 34
  const PAD_Y = 14
  const series = ['total', ...products].filter((k) => show.has(k))
  const valueOf = (r: ScanRun, k: string) => (k === 'total' ? r.ours : r.perProduct[k] ?? 0)
  const peak = Math.max(1, ...runs.flatMap((r) => series.map((k) => valueOf(r, k))))

  const x = (i: number) => PAD_X + (i * (W - PAD_X - 8)) / Math.max(1, runs.length - 1)
  const y = (v: number) => H - PAD_Y - (v / peak) * (H - PAD_Y * 2)

  return (
    <div className="relative px-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[200px]">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={PAD_X}
              x2={W - 8}
              y1={y(peak * f)}
              y2={y(peak * f)}
              stroke="#3f3f46"
              strokeWidth={0.5}
              strokeDasharray="3 3"
            />
            <text x={4} y={y(peak * f) + 3} fill="#71717a" fontSize={9}>
              {Math.round(peak * f)}
            </text>
          </g>
        ))}
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD_Y} y2={H - PAD_Y} stroke="#52525b" strokeWidth={1} />
        )}
        {series.map((k) => (
          <polyline
            key={k}
            fill="none"
            stroke={colourOf(k)}
            strokeWidth={k === 'total' ? 2 : 1.5}
            strokeOpacity={k === 'total' ? 1 : 0.9}
            points={runs.map((r, i) => `${x(i)},${y(valueOf(r, k))}`).join(' ')}
          />
        ))}
        {series.map((k) =>
          runs.map((r, i) => (
            <circle
              key={`${k}-${r.id}`}
              cx={x(i)}
              cy={y(valueOf(r, k))}
              r={hover === i ? 3.5 : 2}
              fill={colourOf(k)}
            />
          ))
        )}
        {/* One hit column per scan: the dots are small and several sit on top of
            each other, so aiming at a column is the only workable target. */}
        {runs.map((r, i) => (
          <rect
            key={`hit-${r.id}`}
            x={x(i) - (W - PAD_X - 8) / Math.max(1, runs.length - 1) / 2}
            y={0}
            width={(W - PAD_X - 8) / Math.max(1, runs.length - 1)}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          />
        ))}
      </svg>

      {hover !== null && (
        <div
          className={`absolute top-1 z-10 pointer-events-none rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-[11px] shadow-xl ${
            hover > runs.length / 2 ? 'left-8' : 'right-4'
          }`}
        >
          <div className="text-zinc-200 font-medium">{fullDate(runs[hover].startedAt)}</div>
          <div className="text-zinc-500 mt-0.5">
            {runs[hover].links.toLocaleString()} link(s) read ·{' '}
            {runs[hover].commentsRead.toLocaleString()} comment(s)
          </div>
          <table className="mt-1.5">
            <tbody>
              <tr>
                <td className="pr-3 text-zinc-300">all products</td>
                <td className="text-zinc-100 tabular-nums">{runs[hover].ours}</td>
              </tr>
              {products.map((p) => (
                <tr key={p}>
                  <td className="pr-3" style={{ color: colourOf(p) }}>
                    {p}
                  </td>
                  <td className="text-zinc-300 tabular-nums">{runs[hover].perProduct[p] ?? 0}</td>
                </tr>
              ))}
              <tr>
                <td className="pr-3 text-zinc-500 pt-1">links carrying ours</td>
                <td className="text-zinc-300 tabular-nums pt-1">{runs[hover].linksWithOurs}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="flex justify-between px-1 text-[10px] text-zinc-600">
        <span>{shortDate(runs[0].startedAt)}</span>
        <span>{shortDate(runs[runs.length - 1].startedAt)}</span>
      </div>
    </div>
  )
}

export default function ScanHistory({ onClose }: { onClose: () => void }) {
  const [scopes, setScopes] = useState<Scope[] | null>(null)
  const [products, setProducts] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [pick, setPick] = useState<string>('')
  const [show, setShow] = useState<Set<string>>(new Set(['total']))

  useEffect(() => {
    fetch('/api/admin/links/scan-history')
      .then((r) => r.json())
      .then((d) => {
        if (d?.error) { setErr(d.error); return }
        const list = (d.scopes ?? []) as Scope[]
        setScopes(list)
        setProducts(d.products ?? [])
        setPick(list[0]?.key ?? '')
        setShow(new Set(['total', ...(d.products ?? [])]))
      })
      .catch((e) => setErr(String(e)))
  }, [])

  const scope = useMemo(() => scopes?.find((s) => s.key === pick) ?? null, [scopes, pick])

  const toggle = (k: string) =>
    setShow((s) => {
      const next = new Set(s)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/70 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-4xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-4 border-b border-zinc-800">
          <div>
            <div className="text-sm font-semibold text-white">Comment scan history</div>
            <div className="text-xs text-zinc-500 mt-0.5">
              Every press of Extract comments, and how many of our comments it found each time.
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded px-2 py-1 shrink-0"
          >
            Close
          </button>
        </div>

        {err && <div className="p-4 text-xs text-rose-300">{err}</div>}
        {!scopes && !err && <div className="p-8 text-center text-xs text-zinc-500">Loading…</div>}

        {scopes?.length === 0 && (
          <div className="p-8 text-center text-xs text-zinc-500">
            No scans recorded yet. Press <span className="text-zinc-300">💬 Extract comments</span> and
            the first one lands here.
          </div>
        )}

        {scopes && scopes.length > 0 && (
          <>
            {/* Each selection of clusters is its own set of links, so each gets
                its own trend. Mixing them on one line would compare counts from
                different videos. */}
            <div className="px-4 py-3 border-b border-zinc-800">
              <label className="text-[11px] text-zinc-500">Which selection of links</label>
              <select
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                className="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500"
              >
                {scopes.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label} — {s.scans} scan{s.scans === 1 ? '' : 's'}, {s.latestOurs} of ours
                    {s.change !== null ? ` (${s.change >= 0 ? '+' : ''}${s.change})` : ''}
                  </option>
                ))}
              </select>
              <div className="text-[10px] text-zinc-600 mt-1">
                Separate because each covers different links — one line for two selections would be
                comparing counts from different videos.
              </div>
            </div>

            <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-zinc-800">
              {['total', ...products].map((k) => (
                <button
                  key={k}
                  onClick={() => toggle(k)}
                  className={`text-[11px] rounded px-2 py-0.5 border transition-colors ${
                    show.has(k)
                      ? 'border-zinc-600 bg-zinc-800 text-zinc-200'
                      : 'border-zinc-800 text-zinc-600'
                  }`}
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                    style={{ background: show.has(k) ? colourOf(k) : '#3f3f46' }}
                  />
                  {k === 'total' ? 'all products' : k}
                </button>
              ))}
            </div>

            {scope && <Trend runs={scope.runs} products={products} show={show} />}

            {scope && (
              <>
                <div className="px-4 pt-3 pb-1 text-[11px] text-zinc-500">
                  Every scan of this selection, newest first
                </div>
                {/* Scrolls both ways: one column per product, so the table outgrows a
                    narrow modal as soon as there are a few of them. */}
                <div className="max-h-[40vh] overflow-auto">
                  <table className="w-full min-w-[640px] text-[11px]">
                    <thead className="sticky top-0 bg-zinc-900">
                      <tr className="text-zinc-500 border-b border-zinc-800">
                        <th className="text-left font-normal px-4 py-1.5">when</th>
                        <th className="text-right font-normal px-2">links</th>
                        <th className="text-right font-normal px-2">comments read</th>
                        <th className="text-right font-normal px-2">links with ours</th>
                        <th className="text-right font-normal px-2 text-zinc-300">ours</th>
                        {products.map((p) => (
                          <th key={p} className="text-right font-normal px-2" style={{ color: colourOf(p) }}>
                            {p.slice(0, 4)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...scope.runs].reverse().map((r, i, arr) => {
                        const prev = arr[i + 1]
                        const delta = prev ? r.ours - prev.ours : null
                        return (
                          <tr key={r.id} className="border-b border-zinc-800/60 text-zinc-400">
                            <td className="px-4 py-1.5 text-zinc-300">{fullDate(r.startedAt)}</td>
                            <td className="text-right px-2 tabular-nums">{r.links.toLocaleString()}</td>
                            <td className="text-right px-2 tabular-nums">
                              {r.commentsRead.toLocaleString()}
                            </td>
                            <td className="text-right px-2 tabular-nums">{r.linksWithOurs}</td>
                            <td className="text-right px-2 tabular-nums text-zinc-100">
                              {r.ours}
                              {delta !== null && delta !== 0 && (
                                <span className={delta > 0 ? ' text-emerald-400' : ' text-rose-400'}>
                                  {' '}
                                  {delta > 0 ? '+' : ''}
                                  {delta}
                                </span>
                              )}
                            </td>
                            {products.map((p) => (
                              <td key={p} className="text-right px-2 tabular-nums">
                                {r.perProduct[p] ?? 0}
                              </td>
                            ))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
