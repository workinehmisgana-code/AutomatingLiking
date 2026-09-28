'use client'

import { useEffect, useMemo, useState } from 'react'

/**
 * Our comments, ordered by how many links carry them.
 *
 * WHAT THIS IS FOR. Every other view of a comment is per-link: you see what is on
 * one video. The number that matters for a set of links is how often the SAME
 * sentence appears across them — one comment on a hundred videos is a string
 * somebody can paste into search and find the whole operation with, and it is
 * invisible unless the comments are counted together. Measured on the real table
 * when this was built, the top line sat on 103 links.
 *
 * AND WHAT EACH ONE COST. The other number on every row is the yield: how many
 * times the comment was handed to a worker against how many links it is actually
 * on. Measured when this was built, one comment had been served 633 times and was
 * visible on 15 links — 2% — while another served 384 times was on 55, at 14%.
 * Both look identical on any per-link view, and one is seven times the work for
 * the same result.
 *
 * It reads what "Extract comments" already saved, and the serving record the app
 * writes as it hands comments out. Nothing is scanned here, so it opens instantly
 * and its numbers are exactly as old as the last scan.
 */
interface Row {
  text: string
  links: number
  hits: number
  products: string[]
  bestRank: number | null
  likes: number
  accounts: number
  lastSeen: string | null
  /** How many times this comment was handed to a worker. */
  served: number
  /** links / served, as a percentage. null when it was never served. */
  ratio: number | null
}

interface LinkRow {
  url: string
  product: string
  rank: number
  likes: number
  username: string
}

const TAG: Record<string, string> = {
  purifytext: 'text-emerald-200 bg-emerald-600/20 border-emerald-500/40',
  acoustictext: 'text-sky-200 bg-sky-600/20 border-sky-500/40',
  prohumanly: 'text-pink-200 bg-pink-600/20 border-pink-500/40',
  humlexic: 'text-amber-200 bg-amber-600/20 border-amber-500/40',
  kinprose: 'text-violet-200 bg-violet-600/20 border-violet-500/40',
  tintfolio: 'text-orange-200 bg-orange-600/20 border-orange-500/40',
}
const tagOf = (p: string) => TAG[p] ?? 'text-zinc-300 bg-zinc-800 border-zinc-700'

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function CommentFrequency({
  query,
  onClose,
}: {
  /** The Links page's current filter, so the tally covers what is on screen. */
  query: string
  onClose: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [scope, setScope] = useState('')
  const [totals, setTotals] = useState({ distinct: 0, hits: 0, links: 0, served: 0 })
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  // Whether to obey the page's filter. Both are worth asking, so both are one
  // click away rather than a page reload.
  const [all, setAll] = useState(false)
  const [find, setFind] = useState('')
  // Which question is being asked of the list. Ordering by links answers "what is
  // most repeated"; by ratio, "what are we handing out and getting nothing for".
  const [sort, setSort] = useState<'links' | 'served' | 'ratio'>('links')
  // Which comment's links are open, and what they are.
  const [open, setOpen] = useState('')
  const [links, setLinks] = useState<LinkRow[]>([])

  useEffect(() => {
    let live = true
    setLoading(true)
    setErr('')
    const qs = all ? 'scope=all' : query
    fetch(`/api/admin/links/comment-tally${qs ? `?${qs}` : ''}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return
        if (d?.error) {
          setErr(String(d.error))
          return
        }
        setRows(Array.isArray(d.rows) ? d.rows : [])
        setScope(String(d.scope ?? ''))
        setTotals({
          distinct: Number(d.distinct) || 0,
          hits: Number(d.hits) || 0,
          links: Number(d.links) || 0,
          served: Number(d.served) || 0,
        })
      })
      .catch(() => live && setErr('Could not load the comment tally.'))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [query, all])

  async function showLinks(text: string) {
    if (open === text) {
      setOpen('')
      return
    }
    setOpen(text)
    setLinks([])
    try {
      const r = await fetch(`/api/admin/links/comment-tally?text=${encodeURIComponent(text)}`)
      const d = await r.json()
      setLinks(Array.isArray(d?.links) ? d.links : [])
    } catch {
      setLinks([])
    }
  }

  const shown = useMemo(() => {
    const q = find.trim().toLowerCase()
    const list = q ? rows.filter((r) => r.text.toLowerCase().includes(q)) : rows.slice()
    if (sort === 'served') return list.sort((a, b) => b.served - a.served)
    if (sort === 'ratio') {
      // WORST FIRST, and only among comments that were actually served — a comment
      // handed out twice and found once is 50% and means nothing. Never-served
      // comments have no ratio and go last rather than counting as 0%.
      const scored = list.filter((r) => r.served >= 20 && r.ratio !== null)
      const rest = list.filter((r) => !(r.served >= 20 && r.ratio !== null))
      scored.sort((a, b) => (a.ratio ?? 0) - (b.ratio ?? 0) || b.served - a.served)
      return [...scored, ...rest]
    }
    return list.sort((a, b) => b.links - a.links)
  }, [rows, find, sort])

  // The widest bar in the list, so the bars are comparable to each other rather
  // than to an arbitrary maximum.
  const top = Math.max(1, ...rows.map((r) => r.links))
  // The yield over everything on screen, which is the one number that says whether
  // serving comments is working at all. COMMENTS FOUND over comments handed out —
  // hits, not links, because a link can carry more than one of ours and both of
  // them were work.
  const overall = totals.served > 0 ? Math.round((100 * totals.hits) / totals.served) : null

  function copyAll() {
    const text = shown
      .map((r) => `${r.links}\t${r.served}\t${r.ratio === null ? '' : `${r.ratio}%`}\t${r.text}`)
      .join('\n')
    void navigator.clipboard?.writeText(text)
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-black/70 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-4xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-zinc-800">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white">Our comments, by how many links carry them</div>
              <div className="text-xs text-zinc-400 mt-0.5">
                {loading
                  ? 'Reading what the last extract saved…'
                  : `${totals.distinct.toLocaleString()} distinct comment(s) on ` +
                    `${totals.links.toLocaleString()} link(s) — ${totals.hits.toLocaleString()} in all`}
              </div>
              {/* THE YIELD, first thing. Served is what we asked workers to post;
                  found is what is actually on a link. */}
              {!loading && totals.served > 0 && (
                <div className="text-xs mt-1">
                  <span className="text-zinc-400">Handed out </span>
                  <span className="text-zinc-200">{totals.served.toLocaleString()}</span>
                  <span className="text-zinc-400"> time(s); </span>
                  <span className="text-zinc-200">{totals.hits.toLocaleString()}</span>
                  <span className="text-zinc-400">
                    {' '}
                    of our comments are on {totals.links.toLocaleString()} link(s) —{' '}
                  </span>
                  <span
                    className={
                      overall !== null && overall < 10
                        ? 'text-rose-300 font-medium'
                        : overall !== null && overall < 25
                          ? 'text-amber-300 font-medium'
                          : 'text-emerald-300 font-medium'
                    }
                    title="Our comments found, as a share of the comments handed to workers. The liker posts from the same bank, so a few of the found ones were never handed to anybody."
                  >
                    {overall}%
                  </span>
                </div>
              )}
              <div className="text-[11px] text-zinc-600 mt-1">
                From what 💬 Extract comments recorded, against the comments the app handed
                out — {scope || '…'}. Nothing is read from TikTok here, so these numbers are
                as old as the last scan of those links.
              </div>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 text-sm text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1.5"
            >
              Close
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="Find a comment…"
              className="flex-1 min-w-[12rem] bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
            />
            <label
              className="flex items-center gap-1.5 text-xs text-zinc-400"
              title="Ignore the page's filter and count every link that has ever been scanned."
            >
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => setAll(e.target.checked)}
                className="accent-emerald-500"
              />
              Every scanned link
            </label>
            <div className="flex rounded-lg overflow-hidden border border-zinc-700">
              {([
                ['links', 'Most links'],
                ['served', 'Most served'],
                ['ratio', 'Worst ratio'],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setSort(k)}
                  title={
                    k === 'ratio'
                      ? 'Lowest yield first, among comments served at least 20 times — a comment handed out twice tells you nothing.'
                      : k === 'served'
                        ? 'The comments workers were given most often.'
                        : 'The comments on the most links.'
                  }
                  className={`px-2.5 py-1.5 text-xs transition-colors ${
                    sort === k ? 'bg-teal-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              onClick={copyAll}
              title="Copy the list as found, served, ratio and comment, one per line"
              className="text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-2.5 py-1.5"
            >
              Copy list
            </button>
          </div>
        </div>

        {err ? (
          <div className="p-6 text-center text-sm text-rose-300">{err}</div>
        ) : loading ? (
          <div className="p-6 text-center text-sm text-zinc-500">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="p-6 text-center text-sm text-zinc-500">
            {rows.length === 0
              ? 'No comments of ours have been recorded for these links. Press 💬 Extract comments first.'
              : 'No comment matches that search.'}
          </div>
        ) : (
          <div className="max-h-[65vh] overflow-y-auto divide-y divide-zinc-800/60">
            {shown.map((r) => (
              <div key={r.text}>
                <div className="flex items-baseline gap-3 px-4 py-2">
                  {/* The count, and a bar so the shape of the distribution is
                      readable without comparing numbers one by one. */}
                  <div className="shrink-0 w-20">
                    <div
                      className={`text-xs tabular-nums font-medium ${
                        r.links >= 10 ? 'text-amber-300' : 'text-zinc-300'
                      }`}
                      title={`On ${r.links} link(s)${r.hits !== r.links ? `, ${r.hits} row(s)` : ''}`}
                    >
                      ×{r.links.toLocaleString()}
                    </div>
                    <div className="h-1 mt-1 rounded bg-zinc-800 overflow-hidden">
                      <div
                        className={r.links >= 10 ? 'h-full bg-amber-500/70' : 'h-full bg-zinc-600'}
                        style={{ width: `${Math.max(3, Math.round((100 * r.links) / top))}%` }}
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => void showLinks(r.text)}
                    className="flex-1 min-w-0 text-left text-xs text-zinc-200 hover:text-white break-words"
                    title="Show the links carrying this comment"
                  >
                    {r.text}
                  </button>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {r.products.map((p) => (
                      <span
                        key={p}
                        className={`text-[10px] rounded px-1.5 py-0.5 border ${tagOf(p)}`}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                  {/* THE YIELD OF THIS ONE COMMENT. Served is how many times a
                      worker was handed it; the percentage is what came of that. */}
                  <span
                    className="shrink-0 w-28 text-right tabular-nums"
                    title={
                      r.served === 0
                        ? 'Never handed to a worker — this one was posted by the liker, so it has no yield to report.'
                        : (r.ratio ?? 0) > 100
                          ? `Handed out ${r.served} time(s) and found on ${r.links} link(s) — more links than servings, because the liker posts from the same bank and its own posts are counted as found.`
                          : `Handed out ${r.served} time(s), found on ${r.links} link(s)`
                    }
                  >
                    {r.served === 0 ? (
                      <span className="text-[11px] text-zinc-600">not served</span>
                    ) : (
                      <>
                        <span
                          className={`text-xs font-medium ${
                            (r.ratio ?? 0) > 100
                              ? // More links than servings: the liker posted it too, so
                                // this is not a yield at all and must not read as a good
                                // one. 43 comments are in this state.
                                'text-sky-300'
                              : (r.ratio ?? 0) < 10
                                ? 'text-rose-300'
                                : (r.ratio ?? 0) < 25
                                  ? 'text-amber-300'
                                  : 'text-emerald-300'
                          }`}
                        >
                          {r.ratio}%
                        </span>
                        <span className="block text-[10px] text-zinc-600">
                          of {r.served.toLocaleString()} served
                        </span>
                      </>
                    )}
                  </span>
                  <span
                    className="shrink-0 text-[11px] text-zinc-600 tabular-nums w-24 text-right"
                    title={
                      `Best position ${r.bestRank === null ? 'unknown' : `#${r.bestRank + 1}`}` +
                      ` · ${r.likes} like(s) · ${r.accounts} account(s)`
                    }
                  >
                    {r.bestRank === null ? '' : `#${r.bestRank + 1}`}
                    {r.lastSeen ? ` · ${when(r.lastSeen)}` : ''}
                  </span>
                </div>
                {open === r.text && (
                  <div className="px-4 pb-3 -mt-1">
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 divide-y divide-zinc-800/60 max-h-56 overflow-y-auto">
                      {links.length === 0 ? (
                        <div className="px-3 py-2 text-[11px] text-zinc-500">Loading links…</div>
                      ) : (
                        links.map((l) => (
                          <div key={l.url + l.rank} className="flex items-center gap-2 px-3 py-1.5">
                            <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums w-10 text-right">
                              #{l.rank + 1}
                            </span>
                            <a
                              href={l.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-1 min-w-0 truncate text-[11px] text-sky-400 hover:text-sky-300"
                            >
                              {l.url}
                            </a>
                            <span className="shrink-0 text-[11px] text-zinc-500">
                              @{l.username}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="p-3 border-t border-zinc-800 text-[11px] text-zinc-600">
          Two numbers worth acting on: a high count means the same sentence is under many
          videos and one search away from being found, and a low ratio means workers are
          being handed a comment that does not end up on the link. Click a comment to see
          which links carry it.
        </div>
      </div>
    </div>
  )
}
