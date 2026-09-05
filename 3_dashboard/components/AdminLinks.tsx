'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clampShare } from '@/lib/clusterMix'
import ScanHistory from '@/components/ScanHistory'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RETIRE_MIN_TIKTOK_YT, clusterCountForDimension, SCAN_MAX_LINKS } from '@/lib/config'

// Default (px) widths for the resizable columns; the Link column flexes to fill.
/** Audience labels and colours, matching the categorise progress bar. */
const CATEGORY_LABEL: Record<string, string> = {
  competitors: 'Competitors',
  ai_detector: 'AI detector',
  generic: 'Generic',
}
const CATEGORY_TONE: Record<string, string> = {
  competitors: 'text-rose-200 bg-rose-600/15 border-rose-500/40',
  ai_detector: 'text-amber-200 bg-amber-600/15 border-amber-500/40',
  generic: 'text-zinc-300 bg-zinc-800 border-zinc-700',
}

const DEFAULT_CW: Record<string, number> = {
  platform: 112, cluster: 96, keyword: 144, title: 288, rank: 88, clicked: 112, ratio: 124,
  parts: 132, ours: 120,
}

// Short labels for the per-product breakdown. Six full product names do not fit
// in a column, and the initials stay readable at 10px where the names would be
// truncated to nothing.
const PRODUCT_TAG: Record<string, string> = {
  purifytext: 'PT',
  acoustictext: 'AT',
  prohumanly: 'PH',
  humlexic: 'HX',
  tintfolio: 'TF',
  kinprose: 'KP',
}
const tagFor = (p: string) => PRODUCT_TAG[p] ?? p.slice(0, 2).toUpperCase()

export interface LinkRow {
  url: string
  platform: string
  search_query: string
  search_rank: number
  like_count: number
  views: number | null
  statsAt: string | null
  /** true = photo carousel, false = real video, null = the ♥ refresh has not
   *  read this link yet. Not derivable from the URL. */
  isPhoto: boolean | null
  /** Audience the link was categorised into; '' until it has been. */
  category: string
  /** The counts behind activePct, shown beside it. */
  channelActive: number
  channelBlocked: number
  /** The blended posted-date score, and the three parts behind it. */
  date_score: number | null
  dsRecency: number | null
  dsVideo: number | null
  dsHearts: number | null
  posted_date: string
  scraped_at: string // ISO timestamp when scraped/uploaded to the dashboard
  unrelated: number
  blocked: boolean
  retireAt: number
  rankCluster: number
  dateCluster: number
  combinedCluster: number
  date_only?: boolean // no search rank; clusters by posted date only
  title?: string // cached video title, sent with the row
  clicks?: number // distinct-user clicks, already scoped to the selected product
  activePct?: number | null // % of this link's channel still active (not blocked)
  /** Our comments on this video per product, from "Extract comments".
   *  {} = extracted and clean, null = never extracted. Different facts. */
  ourComments?: Record<string, number> | null
  /** How much of the video the extraction actually read. A "none" from a video
   *  where 12 of 981 comments were read is far weaker than one from 3 of 3. */
  scanRead?: number | null
  scanTotal?: number | null
  scanComplete?: boolean
}

type SortCol = 'cluster' | 'clicked_by'
type ClusterBy = 'rank' | 'date' | 'combined'

const PLATFORMS: { key: string; label: string; dot: string }[] = [
  { key: 'tiktok', label: 'TikTok', dot: 'bg-pink-500' },
  { key: 'youtube_shorts', label: 'YT Shorts', dot: 'bg-orange-500' },
  { key: 'youtube_videos', label: 'YT Videos', dot: 'bg-red-500' },
  { key: 'instagram', label: 'Instagram', dot: 'bg-fuchsia-500' },
]

const PAGE_SIZE = 100
// Rows fetched per request. Paging inside this window costs nothing; the pool is
// ~82k links, so shipping it whole to filter in the browser is what this avoids.
const WINDOW_SIZE = 1000

/** Posted-date cluster weights, held as PERCENTAGES while being edited — typing
 *  "60" is friendlier than "0.6", and the server renormalises whatever it gets
 *  so the three boxes don't have to add up to exactly 100. */
interface Weights {
  recency: number
  isVideo: number
  hearts: number
}
const DEFAULT_WEIGHTS: Weights = { recency: 30, isVideo: 10, hearts: 60 }

/** One row of the permanent block list (read from blocked_link, not the pool). */
interface BlockedRow {
  url: string
  blockedAt: string
  title: string
  /** Still in videos.json — i.e. unblocking actually brings it back. */
  inPool: boolean
}
const BLOCKED_PAGE = 100

/** The block list grouped to one row per channel. */
interface BlockedChannel {
  handle: string
  blocked: number
  lastBlocked: string
  sampleUrl: string
}
const WEIGHT_FIELDS: { key: keyof Weights; label: string; hint: string }[] = [
  { key: 'hearts', label: 'Hearts', hint: "That video's own like/heart count" },
  { key: 'recency', label: 'Posted date', hint: 'How new the post is' },
  { key: 'isVideo', label: 'Video vs photo', hint: 'Videos score, photo/slideshow posts miss it' },
]

/**
 * A long job's progress bar, pinned to the bottom of the viewport.
 *
 * These used to render inline just above the pagination — i.e. below a hundred
 * table rows — so pressing a button at the top of the page appeared to do
 * nothing. Fixed positioning is the whole point: the job is started from the
 * toolbar and has to stay visible while it runs.
 */
function JobBar({
  title,
  scope,
  done,
  total,
  note,
  colour,
  running,
  onStop,
  onDismiss,
  children,
}: {
  title: string
  scope?: string
  done: number
  total: number
  note: string
  colour: string
  running: boolean
  onStop?: () => void
  /** Clears a FINISHED bar. Without it the last run stays pinned until reload. */
  onDismiss?: () => void
  children?: React.ReactNode
}) {
  const pct = total > 0 ? Math.min(100, (100 * done) / total) : 0
  return (
    <div className="w-[min(92vw,28rem)] rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl p-3 backdrop-blur pointer-events-auto">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-sm text-zinc-100 truncate">
          {title}
          {scope && <span className="text-zinc-500 font-normal"> · {scope}</span>}
        </span>
        <span className="text-xs text-zinc-500 tabular-nums shrink-0">
          {done.toLocaleString()} / {total.toLocaleString()}
          {total > 0 && ` · ${Math.floor(pct)}%`}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${running ? colour : 'bg-zinc-600'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {children}
      <div className="flex items-center justify-between gap-2 mt-2">
        <span className="text-xs text-zinc-500 truncate">{note}</span>
        {running && onStop && (
          <button
            onClick={onStop}
            className="text-xs text-zinc-200 hover:text-white border border-zinc-600 hover:border-zinc-400 rounded px-2 py-0.5 shrink-0"
          >
            Stop
          </button>
        )}
        {!running && onDismiss && (
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            className="text-xs text-zinc-500 hover:text-zinc-200 px-1.5 shrink-0"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}

function dotFor(platform: string): string {
  return PLATFORMS.find((p) => p.key === platform)?.dot ?? 'bg-zinc-600'
}
function labelFor(platform: string): string {
  return PLATFORMS.find((p) => p.key === platform)?.label ?? platform
}
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

export default function AdminLinks({
  retireCap,
  instagramRetire,
  clusterCount,
}: {
  retireCap: number
  instagramRetire: number
  clusterCount: number
}) {
  // Rows, totals and the filter option lists all come from /api/admin/links/list.
  // The pool is ~82k links; shipping it here to filter in the browser cost ~26 MB
  // per page load to render a hundred rows, so the server does that work now and
  // sends one WINDOW plus the pool-wide counts.
  const [rows, setRows] = useState<LinkRow[]>([])
  const [winStart, setWinStart] = useState(0) // row index the window begins at
  const [matched, setMatched] = useState(0) // links matching the filters
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [counts, setCounts] = useState<{
    total: number
    byPlatform: Record<string, number>
    retired: number
    unrelated: number
    blocked: number
  }>({ total: 0, byPlatform: {}, retired: 0, unrelated: 0, blocked: 0 })
  const [uploadDays, setUploadDays] = useState<string[]>([])
  const [products, setProducts] = useState<string[]>([])
  const [retirePlatforms, setRetirePlatforms] = useState<string[]>([])
  const router = useRouter()
  const [platform, setPlatform] = useState('') // '' = all
  // Clicks are always counted for a specific product (retirement is per product);
  // default to the first product (purifytext). No "all products" option.
  const [productSel, setProductSel] = useState(products[0] ?? '')
  const [retiredOnly, setRetiredOnly] = useState(false)
  const [unrelatedOnly, setUnrelatedOnly] = useState(false)
  const [showTitles, setShowTitles] = useState(false) // show the Title column
  const [deletingUrl, setDeletingUrl] = useState<string | null>(null)
  const [clearingUrl, setClearingUrl] = useState<string | null>(null)
  const [blockingUrl, setBlockingUrl] = useState<string | null>(null)
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkBlocking, setBulkBlocking] = useState(false)
  // Row selection (by URL) — bulk actions apply to the selected rows.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkClearing, setBulkClearing] = useState(false)
  const [pinSelected, setPinSelected] = useState(false) // float selected rows to the top
  // When reviewing unrelated links, clicking one opens it AND pops this decision modal.
  const [reviewLink, setReviewLink] = useState<LinkRow | null>(null)
  // Video titles (by URL) — seeded from what's already saved in the DB, then
  // extended by "Process" (which only fetches the ones we don't have yet).
  const [titles, setTitles] = useState<Record<string, string>>({})
  // The table swaps to the focused "Title" layout in unrelated review OR when
  // the admin turns on "Show titles" (also auto-enabled by Process).
  const titleMode = unrelatedOnly || showTitles
  const [processing, setProcessing] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [blockingNext, setBlockingNext] = useState(false)

  // Resizable column widths (px), drag the right edge of a header cell to resize.
  const [cw, setCw] = useState<Record<string, number>>(DEFAULT_CW)
  useEffect(() => {
    try {
      const s = localStorage.getItem('adminlinks_cw')
      if (s) setCw({ ...DEFAULT_CW, ...JSON.parse(s) })
    } catch {}
  }, [])
  function startResize(key: string, e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = cw[key] ?? DEFAULT_CW[key] ?? 100
    const move = (ev: MouseEvent) =>
      setCw((p) => ({ ...p, [key]: Math.max(48, Math.round(startW + ev.clientX - startX)) }))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setCw((p) => {
        try { localStorage.setItem('adminlinks_cw', JSON.stringify(p)) } catch {}
        return p
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // The keyword column became the CATEGORY column: which audience a link
  // reaches decides what comment it should get, while the keyword it happened to
  // be scraped under says little. The keyword itself is still on the link's
  // tooltip, and still searchable in the box above.
  const [category, setCategory] = useState('') // '' = every audience
  const [uploadDate, setUploadDate] = useState('') // '' = all upload days (YYYY-MM-DD)
  const [titleFilter, setTitleFilter] = useState<'' | 'has' | 'none'>('')
  // TikTok serves photo-mode posts (image carousels) under /video/<id> and only
  // rewrites the URL to /photo/<id> in the browser, so the flag comes from the
  // counts refresh — 'unknown' is everything that refresh has not reached yet.
  const [mediaFilter, setMediaFilter] = useState<'' | 'photo' | 'video' | 'unknown'>('')
  // Per-channel active/blocked counts, loaded on demand by the Ratio button.
  // Kept out of the page payload because it needs videos.json + blocked_link and
  // most visits never look at it.
  // Active/blocked ratio: computed server-side per row (activePct) so it can be
  // filtered and paged like any other column. `showRatio` only controls whether
  // the column is displayed.
  const [showRatio, setShowRatio] = useState(false)
  // The Active % column also appears with titles on. Title mode hides the rank
  // and clicked columns to make room, which leaves space for it, and judging a
  // link by its title is exactly when its channel's health is worth seeing.
  // activePct is always computed server-side, so this costs nothing extra.
  const ratioColumn = showRatio || titleMode
  const [minRatio, setMinRatio] = useState('')
  const [maxRatio, setMaxRatio] = useState('')
  const [reclustering, setReclustering] = useState(false)
  const [reclusterOpen, setReclusterOpen] = useState(false)
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS)
  const [weightsLoading, setWeightsLoading] = useState(false)
  // How the two clusterings are mixed when links are served: the percentage of
  // links drawn from the posted-date ordering, the rest from search rank. Held
  // as text so the box can be cleared mid-edit without snapping back to a
  // number; an empty box saves as the default, never as 0.
  const [dateShare, setDateShare] = useState('')
  const [savedShare, setSavedShare] = useState<number | null>(null)
  const [savingShare, setSavingShare] = useState(false)
  // Everything occasional — exports, title tools, the block list, the
  // pipeline controls, the rank/date mix — is one toggle away rather than
  // permanently on screen. Six stacked bands of controls used to push the
  // table itself below the fold on a laptop.
  const [toolsOpen, setToolsOpen] = useState(false)
  useEffect(() => {
    fetch('/api/admin/cluster-mix')
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.dateShare === 'number') {
          setSavedShare(d.dateShare)
          setDateShare(String(d.dateShare))
        }
      })
      .catch(() => {})
  }, [])
  async function saveShare() {
    setSavingShare(true)
    try {
      const res = await fetch('/api/admin/cluster-mix', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateShare: dateShare.trim() === '' ? null : Number(dateShare) }),
      })
      const d = await res.json()
      if (typeof d?.dateShare === 'number') {
        setSavedShare(d.dateShare)
        setDateShare(String(d.dateShare))
      }
    } catch {
      /* leave the field as typed so the value is not lost */
    } finally {
      setSavingShare(false)
    }
  }
  // Count refresh runs as a client-driven loop of short server batches, because
  // ~89k embed fetches cannot fit in one serverless request.
  const [refreshing, setRefreshing] = useState(false)
  const [refreshDone, setRefreshDone] = useState(0)
  const [refreshTotal, setRefreshTotal] = useState(0)
  const [refreshFailed, setRefreshFailed] = useState(0)
  const [refreshNote, setRefreshNote] = useState('')
  // Age window in days, typed freely; 0 (or empty) = every link. Held as text so
  // the box can be cleared mid-edit without snapping back to a number.
  // ── Permanent block list ───────────────────────────────────────────────────
  const [blOpen, setBlOpen] = useState(false)
  const [blRows, setBlRows] = useState<BlockedRow[]>([])
  const [blMatched, setBlMatched] = useState(0)
  const [blOffset, setBlOffset] = useState(0)
  const [blQuery, setBlQuery] = useState('')
  const [blSort, setBlSort] = useState<'recent' | 'oldest' | 'url'>('recent')
  const [blLoading, setBlLoading] = useState(false)
  const [blSel, setBlSel] = useState<Set<string>>(new Set())
  const [blBusy, setBlBusy] = useState(false)
  const [blNote, setBlNote] = useState('')

  // ── Audience categorisation ────────────────────────────────────────────────
  const [catRunning, setCatRunning] = useState(false)
  const [catDone, setCatDone] = useState(0)
  const [catTotal, setCatTotal] = useState(0)
  const [catCounts, setCatCounts] = useState<Record<string, number>>({})
  const [catNote, setCatNote] = useState('')
  const stopCat = useRef(false)
  const catAbort = useRef<AbortController | null>(null)

  function stopCatNow() {
    stopCat.current = true
    setCatNote('Stopping…')
    catAbort.current?.abort()
  }
  // Size of the WHOLE block list. counts.blocked only sees blocked links that
  // still have a pool row — about 2% of them — so it cannot label this button.
  const [blTotal, setBlTotal] = useState<number | null>(null)
  // Grouped view: one row per channel instead of per link. 100k rows is
  // unreadable link by link, and a block is nearly always a judgement about a
  // channel rather than one video.
  const [blByChannel, setBlByChannel] = useState(false)
  const [blChannels, setBlChannels] = useState<BlockedChannel[]>([])
  const [blSelChannels, setBlSelChannels] = useState<Set<string>>(new Set())
  const [blLinkCount, setBlLinkCount] = useState(0)
  useEffect(() => {
    fetch('/api/admin/links/blocked?count=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setBlTotal(Number(d.matched) || 0) })
      .catch(() => { /* label just stays unnumbered */ })
  }, [])

  const [refreshDaysText, setRefreshDaysText] = useState('30')
  const refreshDays = Math.max(0, Math.floor(Number(refreshDaysText) || 0))
  // How many links the typed window covers. Only fetched once the admin actually
  // edits the box — the count needs the whole pool server-side, which is not
  // worth paying for on every visit to the Links page.
  const [windowTouched, setWindowTouched] = useState(false)
  const [windowCount, setWindowCount] = useState<number | null>(null)
  const stopRefresh = useRef(false)
  // Stop must ABORT the request in flight, not just raise a flag: a batch runs
  // for ~40 seconds, so a flag checked between batches leaves the button looking
  // broken for most of a minute.
  const refreshAbort = useRef<AbortController | null>(null)

  function stopRefreshNow() {
    stopRefresh.current = true
    setRefreshNote('Stopping…')
    refreshAbort.current?.abort()
  } // '' = all, has/none = by title presence
  const [q, setQ] = useState('')
  // Pagination is a row OFFSET (not a page index) so "Block & Bring Next batch"
  // can land on an arbitrary row after blocking removes some rows mid-list.
  const [offset, setOffset] = useState(0)

  // The day (YYYY-MM-DD) a link was scraped/uploaded to the dashboard.
  const uploadDay = (l: LinkRow) => {
    const m = (l.scraped_at || '').match(/^(\d{4}-\d{2}-\d{2})/)
    return m ? m[1] : ''
  }
  // Clicks come stamped on each row, already scoped to the selected product by
  // the server — the browser no longer holds the whole click table.
  const clicksOf = (l: LinkRow): number => l.clicks ?? 0
  // Selected clusters. EMPTY = no filter (all clusters), otherwise only these.
  const [clusters, setClusters] = useState<Set<number>>(new Set())
  const [clusterMenuOpen, setClusterMenuOpen] = useState(false)
  const [clusterBy, setClusterBy] = useState<ClusterBy>('rank') // which dimension
  // The posted-date score's three parts. Only shown when the DATE dimension is
  // what orders the table — under "Search rank" these numbers explain nothing
  // about the order on screen.
  const partsColumn = clusterBy !== 'rank'
  const [minClicks, setMinClicks] = useState('')
  const [maxClicks, setMaxClicks] = useState('')

  // The cluster number for the currently selected dimension.
  const clusterOf = (l: LinkRow) =>
    clusterBy === 'rank' ? l.rankCluster : clusterBy === 'date' ? l.dateCluster : l.combinedCluster

  // How many clusters the ACTIVE dimension actually has: rank 30, date 50, and
  // combined = min(rank, date) so it tops out at the rank count. The prop is the
  // max across dimensions, which would otherwise offer clusters that can't match.
  const activeClusterCount = Math.min(clusterCount, clusterCountForDimension(clusterBy))

  // Switching dimension can leave selections above the new maximum (e.g. #45 from
  // "Posted date" while now on "Search rank"), which would silently match nothing.
  useEffect(() => {
    setClusters((prev) => {
      const kept = new Set(Array.from(prev).filter((n) => n <= activeClusterCount))
      return kept.size === prev.size ? prev : kept
    })
  }, [activeClusterCount])

  // Close the cluster popover on an outside click or Escape — it sits inside a
  // scrolling table header, so leaving it open while the user works elsewhere is
  // worse than a plain <select>.
  const clusterMenuRef = useRef<HTMLDivElement>(null)
  const clusterBtnRef = useRef<HTMLButtonElement>(null)
  // The table container is `overflow-hidden` for its rounded corners, which would
  // clip an absolutely-positioned panel whenever the list is short. Anchor it with
  // position:fixed to the button's on-screen box so it can never be cut off.
  const [clusterMenuPos, setClusterMenuPos] = useState<{ top: number; left: number } | null>(null)
  /** Where the panel sits, from the button's on-screen box. */
  const clusterMenuAnchor = useCallback(() => {
    const r = clusterBtnRef.current?.getBoundingClientRect()
    if (!r) return null
    const width = 160
    return {
      top: r.bottom + 4,
      // Keep it on screen if the column sits near the right edge.
      left: Math.min(r.left, window.innerWidth - width - 8),
      // Whether the button is still visible at all.
      onScreen: r.bottom > 0 && r.top < window.innerHeight,
    }
  }, [])
  const openClusterMenu = () => {
    const a = clusterMenuAnchor()
    if (a) setClusterMenuPos({ top: a.top, left: a.left })
    setClusterMenuOpen((o) => !o)
  }
  useEffect(() => {
    if (!clusterMenuOpen) return
    const onDown = (e: MouseEvent) => {
      const el = clusterMenuRef.current
      // The toggle button is outside the panel; let its own handler do the work.
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement)?.closest?.('[aria-expanded]')) {
        setClusterMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setClusterMenuOpen(false) }
    // The panel is position:fixed, so it has to be told when the button moves
    // under it. This used to just close on any scroll — and because the listener
    // is on capture, "any scroll" included scrolling the panel's OWN list, so
    // the menu shut the moment you tried to reach cluster #30.
    //
    // A scroll that starts inside the panel is someone reading the list; leave
    // it alone. Anything else moved the page, so follow the button rather than
    // closing, and only give up once the button has left the screen — following
    // it off-screen would park the panel over unrelated rows.
    const onScroll = (e: Event) => {
      const t = e.target as Node | null
      if (t && clusterMenuRef.current?.contains(t)) return
      const a = clusterMenuAnchor()
      if (!a || !a.onScreen) {
        setClusterMenuOpen(false)
        return
      }
      setClusterMenuPos({ top: a.top, left: a.left })
    }
    const onResize = () => {
      const a = clusterMenuAnchor()
      if (!a || !a.onScreen) {
        setClusterMenuOpen(false)
        return
      }
      setClusterMenuPos({ top: a.top, left: a.left })
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [clusterMenuOpen, clusterMenuAnchor])

  const toggleCluster = (n: number) =>
    setClusters((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })

  // Compact label for the header button: "All", "#3", "#3, #7", else "N clusters".
  const clusterLabel = (() => {
    if (clusters.size === 0) return 'All'
    const sorted = Array.from(clusters).sort((a, b) => a - b)
    if (sorted.length <= 2) return sorted.map((n) => `#${n}`).join(', ')
    return `${sorted.length} clusters`
  })()
  // Sort by a column: null = original order, then desc, then asc.
  const [sort, setSort] = useState<{ col: SortCol; dir: 'asc' | 'desc' } | null>(null)

  // Engagement retirement is per platform: the "Enforce link quota limits" master
  // switch AND that platform's own retirement switch. A link on a platform with
  // retirement off is never retired, even while other platforms retire normally.
  // The per-platform hourly quotas are separate and don't affect this.
  const retireSet = useMemo(() => new Set(retirePlatforms), [retirePlatforms])
  const anyRetireOn = retireSet.size > 0
  const isRetired = (l: LinkRow) => retireSet.has(l.platform) && clicksOf(l) >= l.retireAt

  async function setBlocked(url: string, block: boolean, skipConfirm = false) {
    if (block && !skipConfirm && !confirm('Block this link forever? It stays hidden from all users even if a future upload re-adds it. (It is not deleted — you can unblock later.)')) return
    setBlockingUrl(url)
    try {
      const res = await fetch('/api/admin/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, action: block ? 'block' : 'unblock' }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d?.error || 'Could not update the block.')
        return
      }
      router.refresh()
    } finally {
      setBlockingUrl(null)
    }
  }

  async function clearUnrelated(url: string) {
    setClearingUrl(url)
    try {
      const res = await fetch('/api/admin/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d?.error || 'Could not clear the unrelated flag.')
        return
      }
      router.refresh()
    } finally {
      setClearingUrl(null)
    }
  }

  async function deleteLink(url: string) {
    if (!confirm('Delete this link permanently from the pool? It will disappear for all users.')) return
    setDeletingUrl(url)
    try {
      const res = await fetch('/api/admin/links', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d?.error || 'Could not delete this link.')
        return
      }
      router.refresh()
    } finally {
      setDeletingUrl(null)
    }
  }

  // The channel a link belongs to — videos.json has no account column, so it is
  // derived from the URL. YouTube watch/shorts URLs carry only a video id, so
  // those rows have no channel and show "—" rather than a misleading number.
  const channelOf = (url: string): string | null => {
    const tt = url.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
    if (tt) return tt[1].toLowerCase()
    const yt = url.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
    if (yt) return yt[1].toLowerCase()
    const ig = url.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)
    if (ig) return ig[1].toLowerCase()
    return null
  }

  // ── Recluster ──────────────────────────────────────────────────────────────
  // Recompute the posted-date cluster scores over the non-blocked pool. Scoring
  // normally happens at upload; this re-runs it after the weights change, or once
  // enough links have been blocked that the percentiles have drifted.

  // Opens the weight modal, seeded with the weights actually in force rather than
  // the defaults — otherwise reclustering twice in a row would quietly reset a
  // weighting the admin had already chosen.
  function openRecluster() {
    setReclusterOpen(true)
    setWeightsLoading(true)
    fetch('/api/admin/links/recluster')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const w = d?.weights
        if (!w) return
        const asPct = (n: unknown) => Math.round(Number(n) * 1000) / 10
        setWeights({ recency: asPct(w.recency), isVideo: asPct(w.isVideo), hearts: asPct(w.hearts) })
      })
      .catch(() => { /* leave the form on the defaults */ })
      .finally(() => setWeightsLoading(false))
  }

  // ── Comment scan ───────────────────────────────────────────────────────────
  // Reads the comments of the FILTERED links, recording which of our product
  // comments are already there and where they sit. Restricted to 1-5 clusters:
  // a video takes 1-5s to read, so one cluster is already ~an hour and the whole
  // pool would be days.
  const [scanning, setScanning] = useState(false)
  const [scanDone, setScanDone] = useState(0)
  const [scanTotal, setScanTotal] = useState(0)
  const [scanWithOurs, setScanWithOurs] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  // The hourly channel harvest. Vercel fires a cron at its next scheduled time
  // and not at deploy, so without a way to start one by hand the first run after
  // a deploy is up to an hour away.
  const [harvesting, setHarvesting] = useState(false)
  const [harvestNote, setHarvestNote] = useState('')
  const [scanNote, setScanNote] = useState('')
  const stopScan = useRef(false)
  const scanAbort = useRef<AbortController | null>(null)

  function stopScanNow() {
    stopScan.current = true
    setScanNote('Stopping…')
    scanAbort.current?.abort()
  }

  // The scan is gated on how many links the filter actually matches, because
  // that is what decides how long it runs — a few seconds each. It used to be
  // gated on the number of CLUSTERS ticked, which measured nothing useful: a
  // cluster is a relative slice, so five of them is ~900 links under one filter
  // and tens of thousands under another, and a small deliberate selection with
  // no clusters ticked was refused outright.
  const scanAllowed = matched > 0 && matched <= SCAN_MAX_LINKS

  async function runHarvest() {
    if (harvesting) return
    setHarvesting(true)
    setHarvestNote('Checking channels…')
    try {
      const res = await fetch('/api/cron/pipeline', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setHarvestNote(d?.error || 'Harvest failed.')
        return
      }
      // One tick of whichever stage the cycle is on, so the summary has to
      // describe the stage it actually ran rather than assume a harvest.
      const dt = (d.detail ?? {}) as Record<string, unknown>
      const say: Record<string, () => string> = {
        idle: () =>
          dt.starting
            ? 'six hours are up — starting a cycle'
            : `waiting · next cycle in ${dt.minutesLeft} min`,
        harvest: () =>
          `${dt.checked} of ${dt.eligible} channel(s) · ${dt.found} new · ` +
          `${dt.merged} merged · ${dt.staged} to verify`,
        extract: () => `read ${dt.read} link(s) · ${dt.progress} · ${dt.withOurs} carry ours`,
        categorise: () => `categorised ${dt.processed} · ${dt.remaining} left`,
        recluster: () => `rescored ${dt.scored} of ${dt.total} link(s)`,
      }
      const what = say[String(d.stage)]?.() ?? JSON.stringify(dt).slice(0, 120)
      setHarvestNote(
        `${d.stage}: ${what}` + (d.done ? ` · finished, next up ${d.nextStage}` : '')
      )
      loadWindow(winStart)
    } catch (e) {
      setHarvestNote(String(e))
    } finally {
      setHarvesting(false)
    }
  }

  async function scanComments() {
    if (scanning) { stopScanNow(); return }
    if (!scanAllowed) return
    // The window offset is irrelevant here — the scan walks the whole filtered
    // set, not the visible page.
    const query = queryFor(0)
    if (!confirm(
      `Read the comments of all ${matched.toLocaleString()} filtered link(s)?\n\n` +
      'Every link is READ AGAIN — this is a fresh count, not a top-up of the last one, so ' +
      'it takes a few seconds per video however many times you have scanned before.\n\n' +
      'The result is saved as one entry in the scan history, so you can see whether our ' +
      'comments on these links are growing. You can stop and resume; stopping keeps what ' +
      'was read.'
    )) return

    stopScan.current = false
    setScanning(true)
    setScanWithOurs(0)
    setScanNote('Starting…')
    let offset = 0
    let withOurs = 0
    // The server opens a run on the first request and returns its id; echoing it
    // keeps one press to one row in the history. Without it every request would
    // open its own run and the trend would be built from fragments.
    let runId: number | null = null
    try {
      const head = await fetch(`/api/admin/links/scan-comments?${query}`)
      const info = await head.json().catch(() => ({}))
      if (!head.ok) { alert(info?.error || 'Could not start.'); return }
      setScanTotal(Number(info.total) || 0)
      setScanDone(0)
      if (Number(info.alreadyScanned) > 0) {
        setScanNote(`${Number(info.alreadyScanned).toLocaleString()} already scanned — skipping those`)
      }

      for (;;) {
        if (stopScan.current) { setScanNote('Stopped — scans so far are saved.'); break }
        const ctl = new AbortController()
        scanAbort.current = ctl
        let res: Response
        try {
          res = await fetch('/api/admin/links/scan-comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(runId ? { offset, query, runId } : { offset, query }),
            signal: ctl.signal,
          })
        } catch {
          setScanNote(
            stopScan.current ? 'Stopped — scans so far are saved.' : 'Connection lost — scans so far are saved.'
          )
          break
        } finally {
          scanAbort.current = null
        }
        if (stopScan.current) { setScanNote('Stopped — scans so far are saved.'); break }
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setScanNote(d?.error || 'Scan failed.'); break }
        if (runId === null && Number(d.runId) > 0) runId = Number(d.runId)
        const next = Number(d.nextOffset)
        if (!Number.isFinite(next) || next <= offset) { setScanNote('Scan stalled.'); break }
        offset = next
        withOurs += Number(d.withOurs) || 0
        setScanDone(offset)
        setScanTotal(Number(d.total) || 0)
        setScanWithOurs(withOurs)
        setScanNote(`${withOurs.toLocaleString()} link(s) already carry one of our comments`)
        if (d.done) {
          setScanNote(`Done — ${withOurs.toLocaleString()} link(s) carry one of ours. Saved to the history.`)
          break
        }
      }
      loadWindow(winStart)
    } finally {
      setScanning(false)
      stopScan.current = false
    }
  }

  // ── Refresh like/view counts ───────────────────────────────────────────
  // Each POST works for ~40s and reports where to resume; this loop keeps going
  // until the server says done. Counts are written per batch, so stopping (or
  // closing the tab) keeps everything already fetched.
  async function refreshStats() {
    if (refreshing) { stopRefreshNow(); return }
    const scope = refreshDays > 0 ? `posted in the last ${refreshDays} days` : 'in the pool'
    if (!confirm(
      `Refresh the like and view count of every TikTok link ${scope}?\n\n` +
      'Progress is saved continuously — you can stop and resume any time. ' +
      'YouTube and Instagram links are skipped (no embed page to read).'
    )) return

    stopRefresh.current = false
    setRefreshing(true)
    setRefreshFailed(0)
    setRefreshNote('Starting…')
    let offset = 0
    let failed = 0
    try {
      const head = await fetch(`/api/admin/links/refresh-stats?days=${refreshDays}`)
      const info = await head.json().catch(() => ({}))
      if (!head.ok) { alert(info?.error || 'Could not start.'); return }
      setRefreshTotal(Number(info.total) || 0)
      setRefreshDone(0)

      for (;;) {
        if (stopRefresh.current) { setRefreshNote('Stopped — progress saved.'); break }
        const ctl = new AbortController()
        refreshAbort.current = ctl
        let res: Response
        try {
          res = await fetch('/api/admin/links/refresh-stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offset, days: refreshDays }),
            signal: ctl.signal,
          })
        } catch {
          // Aborted, or the connection dropped. Counts written by earlier
          // batches are already saved; only this batch is lost.
          setRefreshNote(
            stopRefresh.current ? 'Stopped — progress saved.' : 'Connection lost — progress saved.'
          )
          break
        } finally {
          refreshAbort.current = null
        }
        if (stopRefresh.current) { setRefreshNote('Stopped — progress saved.'); break }
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setRefreshNote(d?.error || 'Refresh failed.'); break }
        offset = Number(d.nextOffset) || offset
        failed += Number(d.failed) || 0
        setRefreshDone(offset)
        setRefreshFailed(failed)
        setRefreshTotal(Number(d.total) || 0)
        if (d.done) { setRefreshNote('Done.'); break }
        // Nothing advanced: TikTok is refusing every request. Backing off here
        // beats spinning through the whole pool marking it all failed.
        if (!Number(d.processed)) { setRefreshNote('No responses — stopped. Try again later.'); break }
      }
      loadWindow(winStart)
    } finally {
      setRefreshing(false)
      stopRefresh.current = false
    }
  }

  useEffect(() => {
    if (!windowTouched || refreshing) return
    let cancelled = false
    setWindowCount(null)
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/links/refresh-stats?days=${refreshDays}`)
        if (!r.ok) return
        const d = await r.json()
        if (!cancelled) setWindowCount(Number(d.total) || 0)
      } catch {
        /* preview only — a failure here must not block the button */
      }
    }, 600)
    return () => { cancelled = true; clearTimeout(t) }
  }, [refreshDays, windowTouched, refreshing])

  const loadBlocked = useCallback(
    async (offset: number, q: string, sort: string, byChannel: boolean) => {
      setBlLoading(true)
      try {
        const p = new URLSearchParams({
          offset: String(offset), limit: String(BLOCKED_PAGE), q, sort,
        })
        if (byChannel) p.set('channels', '1')
        const res = await fetch(`/api/admin/links/blocked?${p}`)
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setBlNote(d?.error || 'Could not load the block list.'); return }
        if (byChannel) {
          setBlChannels(Array.isArray(d.rows) ? d.rows : [])
          setBlLinkCount(Number(d.links) || 0)
        } else {
          setBlRows(Array.isArray(d.rows) ? d.rows : [])
        }
        setBlMatched(Number(d.matched) || 0)
        setBlOffset(offset)
        setBlNote('')
      } finally {
        setBlLoading(false)
      }
    },
    []
  )

  function openBlocked() {
    setBlOpen(true)
    setBlSel(new Set())
    loadBlocked(0, blQuery, blSort, blByChannel)
  }

  // Selecting every match needs the server: the page only holds 100 rows, and
  // "unblock everything matching this search" must mean exactly that.
  async function selectAllMatching() {
    setBlBusy(true)
    try {
      const res = await fetch(`/api/admin/links/blocked?urls=1&q=${encodeURIComponent(blQuery)}`)
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setBlNote(d?.error || 'Could not select all.'); return }
      setBlSel(new Set<string>(Array.isArray(d.urls) ? d.urls : []))
    } finally {
      setBlBusy(false)
    }
  }

  async function blockAction(
    action: 'unblock' | 'block',
    urls: string[],
    handles: string[] = []
  ) {
    if (urls.length === 0 && handles.length === 0) return
    // A channel unblock is expressed as handles, not URLs: the server expands
    // them, so the client never has to hold 455 URLs to undo one channel.
    const what = handles.length > 0
      ? `every blocked link of ${handles.length.toLocaleString()} channel(s)`
      : `${urls.length.toLocaleString()} link(s)`
    if (action === 'unblock' && !confirm(
      `Unblock ${what}?\n\n` +
      'Links still in the pool go straight back to users. Links no longer in the ' +
      'pool stay out of circulation until an upload re-adds them — unblocking ' +
      'just stops them being filtered.'
    )) return
    setBlBusy(true)
    try {
      const res = await fetch('/api/admin/links/blocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(handles.length > 0 ? { action, handles } : { action, urls }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setBlNote(d?.error || `Could not ${action}.`); return }
      setBlNote(
        `${action === 'unblock' ? 'Unblocked' : 'Re-blocked'} ` +
        `${Number(d.changed ?? 0).toLocaleString()} link(s)` +
        (d.restored ? `, ${Number(d.restored).toLocaleString()} put back into the active list` : '') +
        '.'
      )
      setBlSel(new Set())
      setBlSelChannels(new Set())
      await loadBlocked(blOffset, blQuery, blSort, blByChannel)
      loadWindow(winStart)
    } finally {
      setBlBusy(false)
    }
  }

  // Sort every link into competitors / ai_detector / generic from its caption and
  // its channel bio. Batched like the count refresh: each POST works ~40s and
  // says where to resume, so ~90k links fit through a 60s serverless limit.
  async function categorize(redo: boolean) {
    if (catRunning) { stopCatNow(); return }
    if (!confirm(
      redo
        ? 'Throw away EVERY category and read all links again?\n\n' +
          'Use this after changing the prompt. Otherwise the normal button only ' +
          'reads links that have no category yet.'
        : 'Categorise the links that do not have an audience yet?\n\n' +
          'Already-categorised links are skipped entirely. Each remaining link is read by ' +
          'Groq from its caption and its channel bio and sorted into competitors / ai ' +
          'detector / generic. Progress is saved continuously — you can stop and resume.'
    )) return

    stopCat.current = false
    setCatRunning(true)
    setCatNote('Starting…')
    try {
      // A redo clears the decisions first; the run below then sees the whole
      // pool as its backlog, with no separate code path.
      if (redo) {
        const wipe = await fetch('/api/admin/links/categorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reset: true }),
        })
        if (!wipe.ok) {
          const d = await wipe.json().catch(() => ({}))
          alert(d?.error || 'Could not clear the existing categories.')
          return
        }
      }

      const head = await fetch('/api/admin/links/categorize')
      const info = await head.json().catch(() => ({}))
      if (!head.ok) { alert(info?.error || 'Could not start.'); return }
      // `total` is the BACKLOG, not the pool — so the bar measures this run's
      // work rather than crawling through 89k already-decided links.
      const backlog = Number(info.total) || 0
      setCatTotal(backlog)
      setCatDone(0)
      setCatCounts(info.counts || {})
      if (backlog === 0) {
        setCatNote(`Nothing to do — all ${Number(info.poolTotal || 0).toLocaleString()} links already categorised.`)
        return
      }
      setCatNote(
        `${backlog.toLocaleString()} link(s) without a category` +
        (info.categorised ? ` · ${Number(info.categorised).toLocaleString()} already done` : '')
      )

      let doneCount = 0
      for (;;) {
        if (stopCat.current) { setCatNote('Stopped — decisions so far are saved.'); break }
        const ctl = new AbortController()
        catAbort.current = ctl
        let res: Response
        try {
          res = await fetch('/api/admin/links/categorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            signal: ctl.signal,
          })
        } catch {
          setCatNote(
            stopCat.current
              ? 'Stopped — decisions so far are saved.'
              : 'Connection lost — decisions so far are saved.'
          )
          break
        } finally {
          catAbort.current = null
        }
        if (stopCat.current) { setCatNote('Stopped — decisions so far are saved.'); break }
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setCatNote(d?.error || 'Categorise failed.'); break }

        const processed = Number(d.processed) || 0
        // There is no offset any more: a batch makes progress by REMOVING links
        // from the backlog. Nothing decided means nothing can be, so stop rather
        // than spin on the same links forever.
        if (processed === 0 && !d.done) { setCatNote('No progress — stopped.'); break }
        doneCount += processed
        setCatDone(Math.min(doneCount, backlog))
        setCatCounts(d.counts || {})
        setCatNote(
          `${doneCount.toLocaleString()} of ${backlog.toLocaleString()} done · ` +
          `${Number(d.remaining || 0).toLocaleString()} left`
        )
        if (d.done) {
          setCatDone(backlog)
          setCatNote('Done — every link has an audience.')
          break
        }
      }
      loadWindow(winStart)
    } finally {
      setCatRunning(false)
      stopCat.current = false
    }
  }

  const weightTotal = weights.recency + weights.isVideo + weights.hearts

  async function recluster() {
    setReclustering(true)
    try {
      const res = await fetch('/api/admin/links/recluster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weights }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Recluster failed.'); return }
      setReclusterOpen(false)
      alert(
        `Reclustered ${Number(d.scored ?? 0).toLocaleString()} link(s)` +
        (d.skippedBlocked ? `, left ${Number(d.skippedBlocked).toLocaleString()} blocked link(s) untouched` : '') +
        '.'
      )
      loadWindow(winStart)
    } finally {
      setReclustering(false)
    }
  }


  // ── Loading the window ─────────────────────────────────────────────────────
  // Every filter is a server query parameter. The response is one WINDOW of
  // WINDOW_SIZE rows plus the pool-wide totals; paging inside that window is
  // free, and only stepping outside it costs another request.
  const queryFor = useCallback(
    (winOffset: number) => {
      const p = new URLSearchParams()
      if (platform) p.set('platform', platform)
      if (productSel) p.set('product', productSel)
      if (retiredOnly) p.set('retired', '1')
      if (unrelatedOnly) p.set('unrelated', '1')
      if (blockedOnly) p.set('blocked', '1')
      if (category) p.set('category', category)
      if (uploadDate) p.set('uploadDate', uploadDate)
      if (titleFilter) p.set('title', titleFilter)
      if (mediaFilter) p.set('media', mediaFilter)
      if (clusters.size) p.set('clusters', Array.from(clusters).join(','))
      p.set('clusterBy', clusterBy)
      if (minClicks.trim() !== '') p.set('minClicks', minClicks.trim())
      if (maxClicks.trim() !== '') p.set('maxClicks', maxClicks.trim())
      if (minRatio.trim() !== '') p.set('minRatio', minRatio.trim())
      if (maxRatio.trim() !== '') p.set('maxRatio', maxRatio.trim())
      if (q.trim()) p.set('q', q.trim())
      if (sort) { p.set('sortCol', sort.col); p.set('sortDir', sort.dir) }
      p.set('offset', String(winOffset))
      p.set('limit', String(WINDOW_SIZE))
      return p.toString()
    },
    [platform, productSel, retiredOnly, unrelatedOnly, blockedOnly, category, uploadDate,
     titleFilter, mediaFilter, clusters, clusterBy, minClicks, maxClicks, minRatio, maxRatio, q, sort]
  )

  const loadWindow = useCallback(
    async (winOffset: number) => {
      setLoading(true)
      setLoadErr('')
      try {
        const res = await fetch(`/api/admin/links/list?${queryFor(winOffset)}`)
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setLoadErr(d?.error || 'Could not load links.'); return }
        setRows(d.rows ?? [])
        setWinStart(d.offset ?? winOffset)
        setMatched(Number(d.matched) || 0)
        setCounts(d.counts ?? counts)
        setUploadDays(d.uploadDays ?? [])
        setProducts(d.products ?? [])
        setRetirePlatforms(d.retirePlatforms ?? [])
        // Seed the title cache from what came back, so "Process" still only
        // fetches the ones we genuinely don't have.
        setTitles((prev) => {
          const next = { ...prev }
          for (const r of (d.rows ?? []) as LinkRow[]) if (r.title) next[r.url] = r.title
          return next
        })
      } catch {
        setLoadErr('Network error while loading links.')
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryFor]
  )

  // A filter change restarts at row 0. Debounced so typing in the search box
  // doesn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => { setOffset(0); loadWindow(0) }, q.trim() ? 350 : 0)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryFor])

  // Paging only refetches when the requested page leaves the window we hold.
  useEffect(() => {
    if (loading) return
    if (offset >= winStart && offset + PAGE_SIZE <= winStart + rows.length) return
    if (offset >= winStart && offset < winStart + rows.length && winStart + rows.length >= matched) return
    loadWindow(Math.floor(offset / WINDOW_SIZE) * WINDOW_SIZE)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset])

  // Filtering and sorting happen on the server (see lib/adminLinks.ts) — the
  // rows we hold ARE the filtered window, so there is nothing left to narrow here.
  const filtered = rows

  // Every URL matching the current filters — NOT just the window we hold. A bulk
  // action that silently stopped at 1,000 rows would be worse than no bulk action.
  async function allFilteredUrls(): Promise<string[]> {
    const res = await fetch(`/api/admin/links/list?${queryFor(0)}&urls=1`)
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { alert(d?.error || 'Could not read the filtered links.'); return [] }
    return (d.urls ?? []) as string[]
  }

  // Bulk actions on the CURRENTLY FILTERED links (narrow with the header filters first).
  async function deleteAllFiltered() {
    const urls = await allFilteredUrls()
    if (urls.length === 0) return
    if (!confirm(`Permanently DELETE all ${urls.length} filtered link(s) from the pool? This disappears for all users and cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      const res = await fetch('/api/admin/links', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not delete these links.'); return }
      alert(`Deleted ${d?.removed ?? urls.length} link(s).`)
      router.refresh()
    } finally {
      setBulkDeleting(false)
    }
  }

  async function blockAllFiltered() {
    const urls = await allFilteredUrls()
    if (urls.length === 0) { alert('All filtered links are already blocked.'); return }
    if (!confirm(`Permanently BLOCK all ${urls.length} filtered link(s)? They stay hidden from all users even if a future upload re-adds them. (Not a delete — you can unblock later.)`)) return
    setBulkBlocking(true)
    try {
      const res = await fetch('/api/admin/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, action: 'block' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not block these links.'); return }
      alert(`Blocked ${d?.blocked ?? urls.length} link(s).`)
      router.refresh()
    } finally {
      setBulkBlocking(false)
    }
  }

  // The server sorts before slicing, so the window is already in order — sorting
  // it again here would only re-order the 1,000 rows we happen to hold.
  const sorted = filtered

  // The list order stays STABLE (no global reordering) so the offset cursor and
  // "Block & Bring Next batch" math stay correct. Selected rows are floated to
  // the top of the VISIBLE page only, for review — see shownDisplay below.
  const ordered = sorted

  // `matched` is the size of the FILTERED set on the server; `ordered` is only
  // the window we currently hold, starting at `winStart`.
  const pageCount = Math.max(1, Math.ceil(matched / PAGE_SIZE))
  const clampedOffset = Math.min(Math.max(0, offset), Math.max(0, matched - 1))
  const clampedPage = Math.floor(clampedOffset / PAGE_SIZE) // for the "N / M" display only
  const inWindow = clampedOffset - winStart
  const shown = inWindow >= 0 ? ordered.slice(inWindow, inWindow + PAGE_SIZE) : []

  // What the table actually renders: after a Mark action (pinSelected) the
  // selected rows float to the top of the CURRENT PAGE so the admin can review
  // them before blocking. This only reorders the visible slice — it does NOT
  // touch `ordered`, so the pagination cursor is unaffected.
  const shownDisplay =
    pinSelected && selected.size > 0
      ? [...shown.filter((l) => selected.has(l.url)), ...shown.filter((l) => !selected.has(l.url))]
      : shown

  // ── Row selection ──────────────────────────────────────────────────────────
  const toggleSelect = (url: string) =>
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(url)) n.delete(url)
      else n.add(url)
      return n
    })
  // Anchor row for shift-click range selection (index within `shown`).
  const lastIndexRef = useRef<number | null>(null)
  function handleRowCheck(index: number, url: string, shift: boolean) {
    if (shift && lastIndexRef.current !== null) {
      const a = Math.min(lastIndexRef.current, index)
      const b = Math.max(lastIndexRef.current, index)
      // Select the whole range, matching the clicked row's resulting state.
      const willSelect = !selected.has(url)
      const range = shownDisplay.slice(a, b + 1).map((l) => l.url)
      setSelected((prev) => {
        const n = new Set(prev)
        range.forEach((u) => (willSelect ? n.add(u) : n.delete(u)))
        return n
      })
    } else {
      toggleSelect(url)
    }
    lastIndexRef.current = index
  }
  const pageUrls = shown.map((l) => l.url)
  const allPageSelected = pageUrls.length > 0 && pageUrls.every((u) => selected.has(u))
  const somePageSelected = pageUrls.some((u) => selected.has(u))
  const toggleSelectPage = () =>
    setSelected((prev) => {
      const n = new Set(prev)
      if (allPageSelected) pageUrls.forEach((u) => n.delete(u))
      else pageUrls.forEach((u) => n.add(u))
      return n
    })
  const clearSelection = () => { setSelected(new Set()); setPinSelected(false) }

  // Bulk actions on the selected rows.
  async function blockSelected() {
    const urls = rows.filter((l) => selected.has(l.url) && !l.blocked).map((l) => l.url)
    if (urls.length === 0) { alert('No selected links to block (they may already be blocked).'); return }
    if (!confirm(`Permanently BLOCK ${urls.length} selected link(s)? They stay hidden even after a future upload re-adds them. (Not a delete — you can unblock later.)`)) return
    setBulkBlocking(true)
    try {
      const res = await fetch('/api/admin/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, action: 'block' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not block these links.'); return }
      alert(`Blocked ${d?.blocked ?? urls.length} link(s).`)
      clearSelection()
      router.refresh()
    } finally {
      setBulkBlocking(false)
    }
  }

  async function deleteSelected() {
    const urls = Array.from(selected)
    if (urls.length === 0) return
    if (!confirm(`Permanently DELETE ${urls.length} selected link(s) from the pool? This disappears for all users and cannot be undone.`)) return
    setBulkDeleting(true)
    try {
      const res = await fetch('/api/admin/links', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not delete these links.'); return }
      alert(`Deleted ${d?.removed ?? urls.length} link(s).`)
      clearSelection()
      router.refresh()
    } finally {
      setBulkDeleting(false)
    }
  }

  async function clearUnrelatedSelected() {
    const urls = rows.filter((l) => selected.has(l.url) && l.unrelated > 0).map((l) => l.url)
    if (urls.length === 0) { alert('None of the selected links have an unrelated flag.'); return }
    if (!confirm(`Clear the unrelated flag on ${urls.length} selected link(s)? They become visible to users again.`)) return
    setBulkClearing(true)
    try {
      await Promise.all(
        urls.map((url) =>
          fetch('/api/admin/links', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, action: 'clear-unrelated' }),
          }).catch(() => {})
        )
      )
      clearSelection()
      router.refresh()
    } finally {
      setBulkClearing(false)
    }
  }

  // Fetch the video title (from its platform) for every link on the current page.
  // TikTok blocks Vercel's datacenter IP, but its oEmbed allows CORS — so we fetch
  // TikTok titles straight from the browser (your residential IP, which TikTok
  // permits). YouTube/Instagram go through the server (YouTube works there;
  // Instagram serves a login wall so it usually can't be resolved).
  async function processTitles() {
    setShowTitles(true) // reveal the Title column
    setProcessing(true)
    try {
      // Re-fetch the title from source for EVERY link on the page (even ones we
      // already have saved) — the freshly-fetched value overwrites the cache.
      const need = shown
      const tiktoks = need.filter((l) => l.platform === 'tiktok')
      const others = need.filter((l) => l.platform !== 'tiktok')

      // TikTok — browser-side oEmbed, a few at a time.
      const tkTitles: Record<string, string> = {}
      let next = 0
      const worker = async () => {
        while (next < tiktoks.length) {
          const l = tiktoks[next++]
          try {
            // TikTok's oEmbed only accepts /video/ URLs — photo (slideshow) posts
            // share the same item id, so rewrite /photo/ → /video/ to get their caption.
            const oembedUrl = l.url.replace('/photo/', '/video/')
            const r = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(oembedUrl)}`)
            if (r.ok) {
              const j = await r.json()
              if (j?.title) tkTitles[l.url] = String(j.title)
            }
          } catch {
            /* ignore this one */
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(5, tiktoks.length) }, worker))

      // YouTube (works) + Instagram (best-effort) — server-side. The route caps
      // each request at 60 items, so send them in batches to cover the whole page.
      const serverTitles: Record<string, string> = {}
      for (let i = 0; i < others.length; i += 50) {
        const batch = others.slice(i, i + 50)
        const res = await fetch('/api/admin/links/titles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: batch.map((l) => ({ url: l.url, platform: l.platform })) }),
        })
        const d = await res.json().catch(() => ({}))
        if (res.ok) Object.assign(serverTitles, d.titles || {})
      }

      const fresh = { ...serverTitles, ...tkTitles }
      setTitles((prev) => ({ ...prev, ...fresh }))
      // Persist the newly-fetched titles so we never fetch them again.
      if (Object.keys(fresh).length > 0) {
        fetch('/api/admin/links/titles/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ titles: fresh }),
        }).catch(() => {})
      }
    } finally {
      setProcessing(false)
    }
  }

  // Use the LLM to classify titles as humanizer/AI-detector related, then select
  // either the RELATED ones or the UNRELATED ones (and float them to the top).
  async function markByTitle(mode: 'related' | 'unrelated') {
    const items = shown.filter((l) => titles[l.url]).map((l) => ({ url: l.url, title: titles[l.url] }))
    if (items.length === 0) { alert('Fetch titles first (Process).'); return }
    setClassifying(true)
    try {
      const res = await fetch('/api/admin/links/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not classify titles.'); return }
      const relatedSet = new Set<string>(Array.isArray(d?.related) ? d.related : [])
      const pick =
        mode === 'related'
          ? items.filter((it) => relatedSet.has(it.url))
          : items.filter((it) => !relatedSet.has(it.url))
      // Select the picked rows and float them to the top of the CURRENT PAGE
      // (pinSelected) so the admin can review them before blocking — without
      // leaving the batch they're on (no jump), keeping the cursor math intact.
      setSelected((prev) => {
        const n = new Set(prev)
        pick.forEach((it) => n.add(it.url))
        return n
      })
      setPinSelected(true)
      const untitled = shown.length - items.length
      alert(
        `Selected ${pick.length} ${mode === 'related' ? 'humanizer related' : 'unrelated'} link(s) ` +
          `of ${items.length} titled link(s) on this page.` +
          (untitled > 0
            ? ` (${untitled} of ${shown.length} rows have no title — usually Instagram login-walled or a failed fetch — so they were skipped. Re-run Process to retry them.)`
            : '')
      )
    } finally {
      setClassifying(false)
    }
  }

  // Block every selected link forever, then refresh so those rows drop out and
  // the next links shift up into their place — i.e. the next batch to process.
  // Used after "Mark humanizer unrelated" selects the bad titles.
  async function blockAndNext() {
    const urls = Array.from(selected)
    if (urls.length === 0) { alert('Select some links first (e.g. Mark humanizer unrelated).'); return }
    setBlockingNext(true)
    try {
      const res = await fetch('/api/admin/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, action: 'block' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not block these links.'); return }
      // Advance the cursor to the rows that were BELOW the current page. On
      // refresh the blocked rows vanish and everything shifts up, so the next
      // start index = (rows above the view that survive) + (kept rows in the
      // view). This lands exactly on the next unprocessed batch — no rows are
      // re-shown and none are skipped.
      const blockedAbove = ordered.slice(0, clampedOffset).filter((l) => selected.has(l.url)).length
      const keptInView = shown.filter((l) => !selected.has(l.url)).length
      const nextOffset = Math.max(0, clampedOffset - blockedAbove + keptInView)
      setSelected(new Set())
      setPinSelected(false)
      setOffset(nextOffset)
      router.refresh()
    } finally {
      setBlockingNext(false)
    }
  }

  // Cycle a column's sort: none → desc → asc → none.
  const cycleSort = (col: SortCol) => {
    setSort((s) =>
      !s || s.col !== col ? { col, dir: 'desc' } : s.dir === 'desc' ? { col, dir: 'asc' } : null
    )
    setOffset(0)
  }
  const arrowFor = (col: SortCol) =>
    sort?.col !== col ? ' ↕' : sort.dir === 'desc' ? ' ↓' : ' ↑'

  // Server export reflects the platform + retired filters (not the text search).
  const exportUrl = (format: 'csv' | 'xls') =>
    `/api/admin/links/export?format=${format}` +
    (platform ? `&platform=${platform}` : '') +
    (productSel ? `&product=${encodeURIComponent(productSel)}` : '') +
    (retiredOnly ? '&retired=1' : '')

  const reset = () => setOffset(0)

  // Pagination controls, shown both above and below the table.
  const paginationBar = (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-zinc-500">
        {matched.toLocaleString()} link{matched === 1 ? '' : 's'}
        {matched > 0 && (
          <>
            {' '}· showing {clampedOffset + 1}–{Math.min(matched, clampedOffset + PAGE_SIZE)}
          </>
        )}
        {loading && <span className="text-zinc-600"> · loading…</span>}
        {loadErr && <span className="text-red-400"> · {loadErr}</span>}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          disabled={clampedOffset === 0}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          ← Prev
        </button>
        <span className="text-zinc-500 tabular-nums">
          {clampedPage + 1} / {pageCount}
        </span>
        <button
          onClick={() => setOffset((o) => Math.min(Math.max(0, ordered.length - 1), o + PAGE_SIZE))}
          disabled={clampedOffset + PAGE_SIZE >= ordered.length}
          className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  )

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white">Links</h1>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/admin/verify-links"
            className="text-xs text-emerald-300 hover:text-emerald-200 border border-emerald-700/50 rounded-lg px-2.5 py-1.5 hover:bg-emerald-900/20 transition-colors"
          >
            Links to verify →
          </Link>
          <Link
            href="/admin"
            className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
          >
            ← Admin
          </Link>
        </div>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        All scraped links available to users. A link is <span className="text-amber-300">retired</span>{' '}
        (finished its quota) once enough distinct users have clicked it — then it&apos;s hidden from
        everyone. The quota is per link (shown in the <span className="text-zinc-300">Clicked by</span>{' '}
        column as <span className="text-zinc-300">clicks / quota</span>): TikTok{' '}
        <span className="text-zinc-400">likes ÷ 5</span> and YouTube{' '}
        <span className="text-zinc-400">views ÷ 50</span> up to {retireCap} (min{' '}
        <span className="text-white">{RETIRE_MIN_TIKTOK_YT}</span>); Instagram always {instagramRetire}.{' '}
        <span className="text-zinc-400">
          Beyond {retireCap} there is <span className="text-white">no cap</span> — the quota keeps
          growing slowly (TikTok likes ÷ 20, YouTube views ÷ 200).
        </span>{' '}
        <span className="text-zinc-400">
          Retirement is counted <span className="text-white">per product</span> — a link retired for
          one product&apos;s users stays available to another&apos;s.
        </span>
      </p>

      {/* Summary + export all */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="text-zinc-300">
              <span className="font-semibold tabular-nums">{counts.total.toLocaleString()}</span> total
            </span>
            {PLATFORMS.map((p) => (
              <span key={p.key} className="flex items-center gap-1.5 text-zinc-400">
                <span className={`w-2 h-2 rounded-full ${p.dot}`} />
                {p.label}
                <span className="tabular-nums text-zinc-200">{(counts.byPlatform[p.key] ?? 0).toLocaleString()}</span>
              </span>
            ))}
            <span className="flex items-center gap-1.5 text-amber-300">
              🔒 retired
              <span className="tabular-nums">{counts.retired.toLocaleString()}</span>
            </span>
            <span className="flex items-center gap-1.5 text-red-300">
              🚫 unrelated
              <span className="tabular-nums">{counts.unrelated.toLocaleString()}</span>
            </span>
            <span className="flex items-center gap-1.5 text-rose-400">
              ⛔ blocked
              <span className="tabular-nums">{counts.blocked.toLocaleString()}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Every filter in one row: the flags, how links are clustered, the
          clicked-by range, the channel-ratio column and the text search.
          Platform / cluster / keyword are column-header dropdowns below. */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label
          className={`flex items-center gap-2 text-sm ${anyRetireOn ? 'text-zinc-300' : 'text-zinc-600'}`}
          title={
            anyRetireOn
              ? `Links retire on: ${retirePlatforms.map((p) => labelFor(p)).join(', ')}. Other platforms never retire.`
              : 'No link is retired — “Enforce link quota limits” is off, or every platform’s retirement switch is off. (The per-platform hourly quotas are separate and still apply.)'
          }
        >
          <input
            type="checkbox"
            checked={retiredOnly && anyRetireOn}
            disabled={!anyRetireOn}
            onChange={(e) => { setRetiredOnly(e.target.checked); reset() }}
            className="accent-amber-500 disabled:opacity-40"
          />
          Finished quota only (retired){anyRetireOn ? '' : ' — off (retirement off)'}
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={unrelatedOnly}
            onChange={(e) => { setUnrelatedOnly(e.target.checked); reset() }}
            className="accent-red-500"
          />
          Marked unrelated only
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={blockedOnly}
            onChange={(e) => { setBlockedOnly(e.target.checked); reset() }}
            className="accent-rose-500"
          />
          Blocked only
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-300" title="Show the fetched video titles in a column (hides some columns to make room)">
          <input
            type="checkbox"
            checked={showTitles}
            onChange={(e) => setShowTitles(e.target.checked)}
            className="accent-teal-500"
          />
          Show titles
        </label>
              <button
          type="button"
          onClick={() => { setShowRatio(true); loadWindow(winStart) }}
          disabled={loading}
          title="For each channel, what share of its links are still active rather than blocked. Shows an Active % column and recalculates it from the current blocked list."
          className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {loading && showRatio ? 'Calculating…' : showRatio ? '↻ Recalculate ratio' : '📊 Channel ratio'}
        </button>
        {showRatio && (
          <button
            type="button"
            onClick={() => { setShowRatio(false); setMinRatio(''); setMaxRatio('') }}
            title="Hide the Active % column and clear its filter"
            className="text-sm text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 transition-colors"
          >
            Hide %
          </button>
        )}
        <div className="flex items-center gap-1.5 text-zinc-400">
          Cluster by:
          <div className="flex rounded-lg overflow-hidden border border-zinc-700">
            <button
              onClick={() => { setClusterBy('rank'); reset() }}
              className={`px-2.5 py-1.5 text-sm transition-colors ${clusterBy === 'rank' ? 'bg-teal-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'}`}
            >
              Search rank
            </button>
            <button
              onClick={() => { setClusterBy('date'); reset() }}
              className={`px-2.5 py-1.5 text-sm transition-colors ${clusterBy === 'date' ? 'bg-teal-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'}`}
            >
              Posted date
            </button>
            <button
              onClick={() => { setClusterBy('combined'); reset() }}
              title="The combined rank+date clustering the user dashboard actually shows"
              className={`px-2.5 py-1.5 text-sm transition-colors ${clusterBy === 'combined' ? 'bg-teal-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'}`}
            >
              Combined
            </button>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-zinc-400">
          Clicked by:
          <input
            type="number"
            min={0}
            value={minClicks}
            onChange={(e) => { setMinClicks(e.target.value); reset() }}
            placeholder="min"
            className="w-20 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
          />
          <span className="text-zinc-600">–</span>
          <input
            type="number"
            min={0}
            value={maxClicks}
            onChange={(e) => { setMaxClicks(e.target.value); reset() }}
            placeholder="max"
            className="w-20 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
          />
          <span className="text-xs text-zinc-600">people</span>
        </label>
        <label className="flex items-center gap-1.5 text-zinc-400" title="Filter by the date the links were scraped/uploaded to the dashboard">
          Uploaded on:
          <select
            value={uploadDate}
            onChange={(e) => { setUploadDate(e.target.value); reset() }}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
          >
            <option value="">All dates</option>
            {uploadDays.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-zinc-400" title="Filter by whether a link has a fetched video title yet">
          Title:
          <select
            value={titleFilter}
            onChange={(e) => { setTitleFilter(e.target.value as '' | 'has' | 'none'); reset() }}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
          >
            <option value="">All</option>
            <option value="has">Has title</option>
            <option value="none">No title</option>
          </select>
        </label>
        <label
          className="flex items-center gap-1.5 text-zinc-400"
          title="Photo posts are image carousels. TikTok serves them under /video/ and only rewrites the URL to /photo/ once the page opens, so this comes from the ♥ refresh — 'Not checked' is what it has not reached yet."
        >
          Media:
          <select
            value={mediaFilter}
            onChange={(e) => { setMediaFilter(e.target.value as '' | 'photo' | 'video' | 'unknown'); reset() }}
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
          >
            <option value="">All</option>
            <option value="photo">🖼 Photo posts</option>
            <option value="video">▶ Videos</option>
            <option value="unknown">Not checked</option>
          </select>
        </label>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); reset() }}
          placeholder="Filter by URL or keyword…"
          className="flex-1 min-w-[160px] bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
        />
      </div>

      {/* Actions that get run often. Everything occasional lives behind
          the Tools toggle, so the table starts within a screen of the top
          instead of below six stacked bands of controls. */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={openRecluster}
          disabled={reclustering}
          title="Set the posted-date weights and recompute the cluster score for every non-blocked link"
          className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
        >
          {reclustering ? 'Reclustering…' : '🧮 Recluster links'}
        </button>
        <button
          type="button"
          onClick={() => categorize(false)}
          title="Sort every link into competitors / ai detector / generic using its caption and its channel bio, so the app serves comments written for that audience."
          className={`text-sm rounded-lg px-3 py-1.5 border transition-colors ${
            catRunning
              ? 'text-amber-200 bg-amber-600/20 border-amber-500/40 hover:bg-amber-600/30'
              : 'text-white bg-zinc-800 hover:bg-zinc-700 border-zinc-700'
          }`}
        >
          {catRunning ? '■ Stop categorising' : '🎯 Categorise links'}
        </button>
        <button
          type="button"
          onClick={scanComments}
          disabled={!scanning && !scanAllowed}
          title={
            scanAllowed || scanning
              ? "Read every filtered link's comments: which of our product comments are already there, how far up, and their likes."
              : matched === 0
                ? 'No links match this filter.'
                : `${matched.toLocaleString()} links match — narrow the filter to ` +
                  `${SCAN_MAX_LINKS.toLocaleString()} or fewer. Each link costs a few ` +
                  'seconds of reading, so this is hours of work either way.'
          }
          className={`text-sm rounded-lg px-3 py-1.5 border transition-colors ${
            scanning
              ? 'text-amber-200 bg-amber-600/20 border-amber-500/40 hover:bg-amber-600/30'
              : scanAllowed
                ? 'text-white bg-zinc-800 hover:bg-zinc-700 border-zinc-700'
                : 'text-zinc-600 bg-zinc-900 border-zinc-800 cursor-not-allowed'
          }`}
        >
          {scanning
            ? '■ Stop scanning'
            : `💬 Extract comments${scanAllowed ? ` (${matched.toLocaleString()} link${matched === 1 ? '' : 's'})` : ''}`}
        </button>
        <button
          type="button"
          onClick={() => setToolsOpen((v) => !v)}
          title="Exports, title tools, the block list, the pipeline controls and the rank/date mix"
          className={`text-sm rounded-lg px-3 py-1.5 border transition-colors ${
            toolsOpen
              ? 'text-white bg-zinc-700 border-zinc-600'
              : 'text-zinc-300 bg-zinc-900 border-zinc-700 hover:bg-zinc-800'
          }`}
        >
          ⚙ Tools {toolsOpen ? '▴' : '▾'}
        </button>
      </div>

      {toolsOpen && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4 space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Pipeline &amp; reports</div>
            <div className="flex flex-wrap items-center gap-2">
        <a
                href="/admin/pipeline"
                title="What the automatic six-hourly cycle has done, turn by turn"
                className="text-sm rounded-lg px-3 py-1.5 border border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700 transition-colors"
              >
                📋 Cycle report
              </a>
              <button
                type="button"
                onClick={runHarvest}
                disabled={harvesting}
                title="Advance the automatic cycle by one step: harvest new channel videos, extract comments, categorise, recluster. It runs by itself every few minutes; this is for starting it straight after a deploy."
                className="text-sm rounded-lg px-3 py-1.5 border border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700 disabled:opacity-50 transition-colors"
              >
                {harvesting ? '⏳ Running…' : '⚙️ Run pipeline step'}
              </button>
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                title="Every past extraction and how many of our comments it found — as a trend per cluster selection"
                className="text-sm rounded-lg px-3 py-1.5 border border-zinc-700 bg-zinc-800 text-white hover:bg-zinc-700 transition-colors"
              >
                📈 Scan history
              </button>
              <a
                href="/admin/replies"
                title="Reply drafts written for the top comment of each scanned link."
                className="text-sm text-violet-200 bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/40 rounded-lg px-3 py-1.5 transition-colors"
              >
                ✍ Reply drafts
              </a>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Titles &amp; blocking</div>
            <div className="flex flex-wrap items-center gap-2">
        <button
                type="button"
                onClick={processTitles}
                disabled={processing}
                className="text-sm text-white bg-teal-600 hover:bg-teal-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
              >
                {processing ? 'Processing…' : '⚙ Process — fetch video titles'}
              </button>
              {Object.keys(titles).length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => markByTitle('related')}
                    disabled={classifying}
                    title="Use AI to select links whose titles ARE about AI humanizers / AI detectors"
                    className="text-sm text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
                  >
                    {classifying ? 'Analyzing…' : '🤖 Mark humanizer related'}
                  </button>
                  <button
                    type="button"
                    onClick={() => markByTitle('unrelated')}
                    disabled={classifying}
                    title="Use AI to select links whose titles are NOT about AI humanizers / AI detectors"
                    className="text-sm text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
                  >
                    {classifying ? 'Analyzing…' : '🤖 Mark humanizer unrelated'}
                  </button>
                  <button
                    type="button"
                    onClick={blockAndNext}
                    disabled={blockingNext || selected.size === 0}
                    title="Block the selected links forever, then load the next batch of links to process"
                    className="text-sm text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
                  >
                    {blockingNext ? 'Blocking…' : `⛔ Block & Bring Next batch${selected.size ? ` (${selected.size})` : ''}`}
                  </button>
                </>
              )}
              <span className="text-xs text-zinc-600">
                Process reads each link&apos;s title (saved for reuse); Mark selects the related or unrelated links.
              </span>
              <button
                type="button"
                onClick={openBlocked}
                title="Browse the permanent block list — every blocked link, including the ones no longer in the pool — and unblock in bulk."
                className="text-sm text-rose-200 bg-rose-600/15 hover:bg-rose-600/25 border border-rose-500/40 rounded-lg px-3 py-1.5 transition-colors"
              >
                ⛔ Blocked list{blTotal !== null ? ` (${blTotal.toLocaleString()})` : ''}
              </button>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Counts &amp; export</div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={refreshStats}
                title="Read each TikTok video's embed page for its current like and view count. Runs in batches; stop and resume any time."
                className={`text-sm rounded-lg px-3 py-1.5 border transition-colors ${
                  refreshing
                    ? 'text-amber-200 bg-amber-600/20 border-amber-500/40 hover:bg-amber-600/30'
                    : 'text-white bg-zinc-800 hover:bg-zinc-700 border-zinc-700'
                }`}
              >
                {refreshing ? '■ Stop refreshing' : '♥ Refresh like & view counts'}
              </button>
              <label
                className="flex items-center gap-1.5 text-sm text-zinc-400"
                title="Only refresh posts younger than this. An older post's like count has already settled, so re-reading it is mostly wasted time. 0 = every post."
              >
                posted in last
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={refreshDaysText}
                  onChange={(e) => { setRefreshDaysText(e.target.value); setWindowTouched(true) }}
                  disabled={refreshing}
                  className="w-16 text-sm text-right text-zinc-100 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 tabular-nums disabled:opacity-40"
                />
                days
                <span className="text-xs text-zinc-600 tabular-nums">
                  {refreshDays === 0
                    ? '(every post)'
                    : windowCount === null
                      ? windowTouched
                        ? '…'
                        : ''
                      : `≈ ${windowCount.toLocaleString()} links, ~${Math.max(1, Math.round(windowCount / 600))} min`}
                </span>
              </label>
        <span className="text-xs text-zinc-500">
                Export {retiredOnly ? 'retired ' : ''}
                {platform ? labelFor(platform) : 'all'} links:
              </span>
              <a
                href={exportUrl('csv')}
                className="text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
              >
                Export CSV
              </a>
              <a
                href={exportUrl('xls')}
                className="text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
              >
                Export Excel
              </a>
              <span className="text-xs text-zinc-600">
                (exports the platform / retired filter — not the text search)
              </span>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">How links are served</div>
            <div className="flex flex-wrap items-center gap-2">
        {/* How the two clusterings are mixed when links are served. */}
              <div
                title={
                  'Of every 100 links served, how many are drawn from the POSTED-DATE ' +
                  'clustering; the rest come from SEARCH RANK. Applies to the app and ' +
                  'the web dashboard. The draw is per link and seeded by the user, so ' +
                  'two people working at the same moment get different blends. ' +
                  'Clearing the box restores the default (75).'
                }
                className="flex items-center gap-1.5 text-xs rounded-lg px-2.5 py-1 border border-zinc-700 bg-zinc-900"
              >
                <span className="text-zinc-400">date</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={dateShare}
                  onChange={(e) => setDateShare(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveShare()
                  }}
                  className="w-12 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-center tabular-nums text-zinc-100 focus:outline-none focus:border-sky-500"
                />
                <span className="text-zinc-500 tabular-nums">
                  % · rank {100 - clampShare(dateShare.trim() === '' ? null : dateShare)}%
                </span>
                <button
                  type="button"
                  onClick={() => void saveShare()}
                  disabled={
                    savingShare ||
                    clampShare(dateShare.trim() === '' ? null : dateShare) === savedShare
                  }
                  className="text-[11px] font-medium rounded px-1.5 py-0.5 border border-sky-600/60 bg-sky-600/20 text-sky-200 hover:bg-sky-600/30 disabled:opacity-40 disabled:hover:bg-sky-600/20 transition-colors"
                >
                  {savingShare ? '…' : 'save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* Selection actions — apply to the checked rows */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-2 rounded-lg border border-teal-700/40 bg-teal-900/20 px-3 py-2 text-sm">
          <span className="text-teal-200 font-medium">{selected.size} selected</span>
          <button
            type="button"
            onClick={blockSelected}
            disabled={bulkBlocking}
            className="text-rose-200 bg-rose-600/80 hover:bg-rose-600 disabled:opacity-40 rounded-lg px-2.5 py-1 transition-colors"
          >
            {bulkBlocking ? '…' : '⛔ Block'}
          </button>
          <button
            type="button"
            onClick={deleteSelected}
            disabled={bulkDeleting}
            className="text-red-200 bg-red-600/80 hover:bg-red-600 disabled:opacity-40 rounded-lg px-2.5 py-1 transition-colors"
          >
            {bulkDeleting ? '…' : '🗑 Delete'}
          </button>
          <button
            type="button"
            onClick={clearUnrelatedSelected}
            disabled={bulkClearing}
            title="Remove the unrelated flag from the selected links"
            className="text-emerald-200 border border-emerald-600/40 hover:bg-emerald-600/20 disabled:opacity-40 rounded-lg px-2.5 py-1 transition-colors"
          >
            {bulkClearing ? '…' : '✕ Clear unrelated'}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto text-xs text-zinc-400 hover:text-zinc-200"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* List */}
      <div className="flex justify-end mb-1">
        <button
          type="button"
          onClick={() => { setCw(DEFAULT_CW); try { localStorage.removeItem('adminlinks_cw') } catch {} }}
          title="Drag a column header's right edge to resize; this restores the defaults."
          className="text-[11px] text-zinc-600 hover:text-zinc-400"
        >
          ↔ Reset column widths
        </button>
      </div>

      {/* Pagination (top) */}
      <div className="mb-2">{paginationBar}</div>

      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        {/* Horizontal scroller. The columns are fixed-width and shrink-0, so on a
            narrow screen they overflow rather than squash — without this they
            spilled out of the card and took the whole page sideways with them.
            Header and rows share ONE scroller so they cannot drift apart. */}
        <div className="overflow-x-auto">
        <div className="flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800 bg-zinc-900/60">
          <span className="w-6 shrink-0 flex items-center justify-center">
            <input
              type="checkbox"
              checked={allPageSelected}
              ref={(el) => { if (el) el.indeterminate = somePageSelected && !allPageSelected }}
              onChange={toggleSelectPage}
              title="Select all on this page"
              className="accent-teal-500 cursor-pointer"
            />
          </span>
          <div className="shrink-0 relative" style={{ width: cw.platform }}>
            <select
              value={platform}
              onChange={(e) => { setPlatform(e.target.value); reset() }}
              title="Filter by platform"
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px] normal-case tracking-normal text-zinc-300 focus:outline-none focus:border-emerald-500"
            >
              <option value="">All platforms</option>
              {PLATFORMS.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
            <span onMouseDown={(e) => startResize('platform', e)} title="Drag to resize" className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-teal-500/60 z-10" />
          </div>
          {!titleMode && (
            <div className="shrink-0 relative flex flex-col items-start gap-1" style={{ width: cw.cluster }}>
              <button
                onClick={() => cycleSort('cluster')}
                title={`Sort by ${clusterBy === 'rank' ? 'search-rank' : clusterBy === 'date' ? 'posted-date' : 'combined'} cluster`}
                className={`text-[11px] uppercase tracking-wide hover:text-zinc-200 transition-colors ${
                  sort?.col === 'cluster' ? 'text-teal-300' : ''
                }`}
              >
                Cluster{arrowFor('cluster')}
              </button>
              {/* Multi-select: pick any number of clusters (none = all). */}
              <button
                type="button"
                ref={clusterBtnRef}
                onClick={openClusterMenu}
                title="Filter by cluster — tick as many as you like"
                aria-expanded={clusterMenuOpen}
                className={`max-w-full w-full flex items-center justify-between gap-1 bg-zinc-900 border rounded px-1 py-0.5 text-[10px] normal-case tracking-normal focus:outline-none ${
                  clusters.size > 0
                    ? 'border-teal-500 text-teal-200'
                    : 'border-zinc-700 text-zinc-300 hover:border-zinc-600'
                }`}
              >
                <span className="truncate">{clusterLabel}</span>
                <span className="text-zinc-500 shrink-0">▾</span>
              </button>
              {clusterMenuOpen && clusterMenuPos && (
                <div
                  ref={clusterMenuRef}
                  style={{ top: clusterMenuPos.top, left: clusterMenuPos.left }}
                  className="fixed z-50 w-40 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl p-1"
                >
                  <div className="flex items-center justify-between gap-1 px-1 pb-1 mb-1 border-b border-zinc-800">
                    <span className="text-[10px] text-zinc-500 normal-case tracking-normal">
                      {clusters.size || 'all'} selected
                    </span>
                    <button
                      type="button"
                      onClick={() => { setClusters(new Set()); reset() }}
                      disabled={clusters.size === 0}
                      className="text-[10px] text-zinc-400 hover:text-white disabled:opacity-40 normal-case tracking-normal"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {Array.from({ length: activeClusterCount }, (_, i) => i + 1).map((n) => (
                      <label
                        key={n}
                        className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-zinc-800 cursor-pointer normal-case tracking-normal"
                      >
                        <input
                          type="checkbox"
                          checked={clusters.has(n)}
                          onChange={() => { toggleCluster(n); reset() }}
                          className="accent-teal-500"
                        />
                        <span className="text-[11px] text-zinc-300 tabular-nums">#{n}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <span onMouseDown={(e) => startResize('cluster', e)} title="Drag to resize" className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-teal-500/60 z-10" />
            </div>
          )}
          <span className="flex-1 min-w-[10rem]">Link</span>
          {!titleMode && (
            <div className="shrink-0 relative" style={{ width: cw.keyword }}>
              <select
                value={category}
                onChange={(e) => { setCategory(e.target.value); reset() }}
                title="Filter by the audience the link was categorised into"
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px] normal-case tracking-normal text-zinc-300 focus:outline-none focus:border-emerald-500"
              >
                <option value="">All categories</option>
                <option value="competitors">Competitors</option>
                <option value="ai_detector">AI detector</option>
                <option value="generic">Generic</option>
              </select>
              <span onMouseDown={(e) => startResize('keyword', e)} title="Drag to resize" className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-teal-500/60 z-10" />
            </div>
          )}
          {titleMode && (
            <span className="shrink-0 relative" style={{ width: cw.title }}>
              Title
              <span onMouseDown={(e) => startResize('title', e)} title="Drag to resize" className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-teal-500/60 z-10" />
            </span>
          )}
          {partsColumn && (
            <div className="shrink-0 relative text-right" style={{ width: cw.parts }}>
              <span
                className="text-[11px] uppercase tracking-wide"
                title={
                  'The three parts of the posted-date score, each a percentile across the pool: ' +
                  'recency (how new), video (1 for video, 0 for a photo post) and hearts ' +
                  '(the channel average). Weighted by the Recluster settings to give the score ' +
                  'the date clusters are cut from.'
                }
              >
                rec · vid · ♥
              </span>
              <span
                onMouseDown={(e) => startResize('parts', e)}
                title="Drag to resize"
                className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-teal-500/60 z-10"
              />
            </div>
          )}
          {ratioColumn && (
            <div className="shrink-0 flex flex-col items-end gap-1" style={{ width: cw.ratio }}>
              <span
                className="text-[11px] uppercase tracking-wide"
                title="Share of this channel's links that are still active (not blocked)"
              >
                Active %
              </span>
              {/* Range filter: leave a box empty for "no bound". Links with no
                  channel are excluded whenever either bound is set — an unknown
                  ratio can't satisfy "below 50%". */}
              <div className="flex items-center gap-0.5">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={minRatio}
                  onChange={(e) => { setMinRatio(e.target.value); reset() }}
                  placeholder="min"
                  title="Only links whose channel is at least this % active"
                  className="w-9 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px] normal-case tracking-normal text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                />
                <span className="text-zinc-600 text-[10px]">–</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={maxRatio}
                  onChange={(e) => { setMaxRatio(e.target.value); reset() }}
                  placeholder="max"
                  title="Only links whose channel is at most this % active"
                  className="w-9 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px] normal-case tracking-normal text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          )}
          {!titleMode && (
            <span className="shrink-0 relative text-right" style={{ width: cw.rank }}>
              Rank / Likes
              <span onMouseDown={(e) => startResize('rank', e)} title="Drag to resize" className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-teal-500/60 z-10" />
            </span>
          )}
          {!titleMode && (
            <div className="shrink-0 relative flex flex-col items-end gap-1" style={{ width: cw.clicked }}>
              <button
                onClick={() => cycleSort('clicked_by')}
                title="Sort by clicked-by count"
                className={`text-[11px] uppercase tracking-wide tabular-nums hover:text-zinc-200 transition-colors ${
                  sort?.col === 'clicked_by' ? 'text-teal-300' : ''
                }`}
              >
                Clicked by{arrowFor('clicked_by')}
              </button>
              <select
                value={productSel}
                onChange={(e) => { setProductSel(e.target.value); reset() }}
                title="Count clicks (and retirement) for this product's users."
                className="max-w-full bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px] normal-case tracking-normal text-zinc-300 focus:outline-none focus:border-emerald-500"
              >
                {products.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <span onMouseDown={(e) => startResize('clicked', e)} title="Drag to resize" className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-teal-500/60 z-10" />
            </div>
          )}
          {!titleMode && (
            <div className="shrink-0 relative text-right" style={{ width: cw.ours }}>
              <span
                className="text-[11px] uppercase tracking-wide"
                title={
                  'How many of OUR comments are on the video, per product, as found by ' +
                  '"Extract comments". A dash means the link has never been extracted — ' +
                  'that is not the same as none being found.'
                }
              >
                Ours
              </span>
              <span onMouseDown={(e) => startResize('ours', e)} title="Drag to resize" className="absolute top-0 -right-1 h-full w-2 cursor-col-resize hover:bg-teal-500/60 z-10" />
            </div>
          )}
          <button
            type="button"
            onClick={blockAllFiltered}
            disabled={bulkBlocking}
            title="Block ALL filtered links (survives re-uploads)"
            className="w-16 shrink-0 text-center text-[10px] normal-case text-rose-300 hover:text-rose-200 disabled:opacity-40 transition-colors"
          >
            {bulkBlocking ? '…' : '⛔ Block all'}
          </button>
          <button
            type="button"
            onClick={deleteAllFiltered}
            disabled={bulkDeleting}
            title="Delete ALL filtered links from the pool"
            className="w-16 shrink-0 text-center text-[10px] normal-case text-red-300 hover:text-red-200 disabled:opacity-40 transition-colors"
          >
            {bulkDeleting ? '…' : '🗑 Delete all'}
          </button>
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-zinc-500 text-center py-12">
            {loading ? 'Loading…' : loadErr ? loadErr : 'No links match these filters.'}
          </p>
        ) : (
          shownDisplay.map((l, idx) => {
            const retired = isRetired(l)
            return (
              <div key={l.url} className={`flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 text-sm ${selected.has(l.url) ? 'bg-teal-500/25 border-l-4 border-l-teal-400 pl-2' : ''}`}>
                <span className="w-6 shrink-0 flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={selected.has(l.url)}
                    onChange={(e) => handleRowCheck(idx, l.url, (e.nativeEvent as MouseEvent).shiftKey)}
                    className="accent-teal-500 cursor-pointer"
                  />
                </span>
                <span className="shrink-0 flex items-center gap-1.5 text-zinc-400 text-xs overflow-hidden" style={{ width: cw.platform }}>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dotFor(l.platform)}`} />
                  <span className="truncate">{labelFor(l.platform)}</span>
                </span>
                {!titleMode && (
                  <span className="shrink-0 text-xs text-zinc-400 tabular-nums" style={{ width: cw.cluster }}>
                    {clusterOf(l) > 0 ? `#${clusterOf(l)}` : '—'}
                  </span>
                )}
                <span className="flex-1 min-w-[10rem]">
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => { if (unrelatedOnly) setReviewLink(l) }}
                    className="text-zinc-300 hover:text-emerald-400 break-all"
                  >
                    {l.url}
                  </a>
                  {l.unrelated > 0 && (
                    <span className="ml-2 inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 border border-red-500/50 bg-red-500/15 text-red-300 whitespace-nowrap align-middle">
                      <span title={`${l.unrelated} user(s) marked this unrelated to humanizers`}>
                        🚫 {l.unrelated}
                      </span>
                      <button
                        onClick={() => clearUnrelated(l.url)}
                        disabled={clearingUrl === l.url}
                        title="Clear the unrelated flag — make this link available to users again"
                        aria-label="Clear unrelated flag"
                        className="ml-0.5 text-red-300 hover:text-white disabled:opacity-40 transition-colors"
                      >
                        {clearingUrl === l.url ? '…' : '✕'}
                      </button>
                    </span>
                  )}
                  {l.blocked && (
                    <span
                      title="Permanently blocked — hidden from all users, and stays blocked even if a new upload re-adds it"
                      className="ml-2 text-[11px] rounded px-1.5 py-0.5 border border-rose-500/50 bg-rose-500/15 text-rose-300 whitespace-nowrap align-middle"
                    >
                      ⛔ blocked
                    </span>
                  )}
                  {l.isPhoto === true && (
                    <span
                      title="Photo post — an image carousel, not a video. TikTok serves it under /video/ and rewrites the URL to /photo/ when the page opens."
                      className="ml-2 text-[11px] rounded px-1.5 py-0.5 border border-violet-500/50 bg-violet-500/15 text-violet-300 whitespace-nowrap align-middle"
                    >
                      🖼 photo
                    </span>
                  )}
                </span>
                {!titleMode && (
                  <button
                    type="button"
                    onClick={() => { setCategory(category === l.category ? '' : l.category); reset() }}
                    title={
                      (l.category
                        ? `Audience: ${CATEGORY_LABEL[l.category] ?? l.category}. Click to filter.`
                        : 'Not categorised yet — press Categorise links.') +
                      (l.search_query ? `\nScraped under “${l.search_query}”.` : '')
                    }
                    className="shrink-0 text-left truncate"
                    style={{ width: cw.keyword }}
                  >
                    {l.category ? (
                      <span
                        className={`text-[11px] font-medium rounded px-1.5 py-0.5 border ${
                          CATEGORY_TONE[l.category] ?? 'text-zinc-400 bg-zinc-800 border-zinc-700'
                        }`}
                      >
                        {CATEGORY_LABEL[l.category] ?? l.category}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-600">—</span>
                    )}
                  </button>
                )}
                {titleMode && (
                  <span
                    className="shrink-0 text-xs text-zinc-300 leading-tight break-words"
                    style={{
                      width: cw.title,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                    title={titles[l.url] || undefined}
                  >
                    {titles[l.url] ? titles[l.url] : processing ? '…' : '—'}
                  </span>
                )}
                {partsColumn && (
                  <span
                    className="shrink-0 text-right text-xs tabular-nums"
                    style={{ width: cw.parts }}
                    title={
                      l.dsRecency === null
                        ? 'Not scored yet — press Recluster links to compute the parts.'
                        : `recency ${l.dsRecency} · ${l.dsVideo ? 'video' : 'photo'} · hearts ` +
                          `${l.dsHearts}` +
                          (l.date_score !== null ? ` → score ${l.date_score}` : '')
                    }
                  >
                    {l.dsRecency === null ? (
                      <span className="text-zinc-700">—</span>
                    ) : (
                      <>
                        <span className="text-sky-400">{l.dsRecency.toFixed(2)}</span>
                        <span className="text-zinc-700"> · </span>
                        <span className={l.dsVideo ? 'text-emerald-400' : 'text-zinc-600'}>
                          {l.dsVideo ?? 0}
                        </span>
                        <span className="text-zinc-700"> · </span>
                        <span className="text-rose-400">{(l.dsHearts ?? 0).toFixed(2)}</span>
                      </>
                    )}
                  </span>
                )}
                {ratioColumn && (() => {
                  const pct = l.activePct ?? null
                  return (
                    <span
                      className={`shrink-0 text-right text-xs tabular-nums ${
                        pct === null ? 'text-zinc-600'
                          : pct >= 80 ? 'text-emerald-400'
                          : pct >= 50 ? 'text-amber-400'
                          : 'text-rose-400'
                      }`}
                      style={{ width: cw.ratio }}
                      title={
                        pct === null
                          ? 'No channel in this URL (YouTube links carry only a video id)'
                          : `${l.channelActive.toLocaleString()} active, ` +
                            `${l.channelBlocked.toLocaleString()} blocked ` +
                            `(including links no longer in the pool) = ${pct}% active`
                      }
                    >
                      {pct === null ? (
                        '—'
                      ) : (
                        <>
                          {pct}%
                          <span className="text-zinc-600">
                            {' '}{l.channelActive.toLocaleString()}/{l.channelBlocked.toLocaleString()}
                          </span>
                        </>
                      )}
                    </span>
                  )
                })()}
                {!titleMode && (
                  <span
                    className="shrink-0 text-right text-xs text-zinc-500 tabular-nums truncate"
                    style={{ width: cw.rank }}
                    title={
                      `search rank ${l.search_rank > 0 ? l.search_rank : 'none'}` +
                      ` · ${l.like_count > 0 ? l.like_count.toLocaleString() : 'unknown'} likes` +
                      (l.views ? ` · ${l.views.toLocaleString()} views` : '') +
                      (l.statsAt ? ` · refreshed ${new Date(l.statsAt).toLocaleDateString()}` : ' · never refreshed')
                    }
                  >
                    {l.search_rank > 0 ? `#${l.search_rank}` : '—'} · {l.like_count > 0 ? fmt(l.like_count) : '?'}
                    {l.views ? <span className="text-zinc-600"> · {fmt(l.views)}▶</span> : null}
                  </span>
                )}
                {!titleMode && (() => {
                  const ours = l.ourComments
                  // Never extracted reads as a dash, not a zero: nobody has
                  // looked, so there is no count to report.
                  if (!ours) {
                    return (
                      <span
                        className="shrink-0 text-right text-xs text-zinc-700"
                        style={{ width: cw.ours }}
                        title="Not extracted yet — run 💬 Extract comments to find out"
                      >
                        —
                      </span>
                    )
                  }
                  const entries = Object.entries(ours).filter(([, n]) => n > 0)
                  const total = entries.reduce((a, [, n]) => a + n, 0)
                  return (
                    <span
                      className="shrink-0 text-right flex items-center justify-end gap-1 overflow-hidden"
                      style={{ width: cw.ours }}
                      title={
                        (total === 0
                          ? 'Extracted: none of our comments among the comments read'
                          : `${total} of our comment(s) on this video: ` +
                            entries
                              .sort((a, b) => b[1] - a[1])
                              .map(([p, n]) => `${p} ${n}`)
                              .join(', ')) +
                        // How far the read actually got. Without this, "none" on
                        // a video where 12 of 981 comments were read looks
                        // exactly like "none" on one with 3 comments total.
                        (l.scanRead == null
                          ? ''
                          : `\n\nRead ${l.scanRead.toLocaleString()} comment(s)` +
                            (l.scanTotal ? ` of the ${l.scanTotal.toLocaleString()} TikTok claims` : '') +
                            (l.scanComplete
                              ? ' — complete.'
                              : ' — PARTIAL, so anything deeper than that was not seen.') +
                            '\nReplies are never read: the list endpoint only returns top-level comments.')
                      }
                    >
                      {total === 0 ? (
                        // Amber rather than green when the read was partial: the
                        // claim is "none in what we saw", not "none".
                        <span
                          className={`text-xs ${
                            l.scanComplete ? 'text-emerald-500/70' : 'text-amber-500/70'
                          }`}
                        >
                          none{l.scanComplete ? '' : '?'}
                        </span>
                      ) : (
                        entries
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 3)
                          .map(([p, n]) => (
                            <span
                              key={p}
                              className="text-[10px] tabular-nums rounded px-1 py-0.5 border border-zinc-700 bg-zinc-800/70 text-zinc-300 shrink-0"
                            >
                              {tagFor(p)}
                              <span className="text-zinc-500"> {n}</span>
                            </span>
                          ))
                      )}
                      {entries.length > 3 && (
                        <span className="text-[10px] text-zinc-600 shrink-0">+{entries.length - 3}</span>
                      )}
                    </span>
                  )
                })()}
                {!titleMode && (
                  <span className="shrink-0 text-right" style={{ width: cw.clicked }}>
                    <span
                      className={`text-xs tabular-nums rounded px-1.5 py-0.5 border ${
                        retired
                          ? 'border-amber-500/50 bg-amber-500/15 text-amber-200 font-semibold'
                          : 'border-zinc-700 text-zinc-400'
                      }`}
                      title={retired ? 'Finished quota — retired' : `${clicksOf(l)}/${l.retireAt} users`}
                    >
                      {retired ? `🔒 ${clicksOf(l)}` : `${clicksOf(l)}/${l.retireAt}`}
                    </span>
                  </span>
                )}
                <button
                  onClick={() => setBlocked(l.url, !l.blocked)}
                  disabled={blockingUrl === l.url}
                  title={
                    l.blocked
                      ? 'Unblock this link (it may reappear if it is in the pool)'
                      : 'Block this link forever — stays hidden even after a new upload re-adds it (not a delete)'
                  }
                  aria-label={l.blocked ? 'Unblock link' : 'Block link'}
                  className={`w-16 shrink-0 text-center disabled:opacity-40 transition-colors ${
                    l.blocked ? 'text-rose-400 hover:text-rose-300' : 'text-zinc-500 hover:text-rose-400'
                  }`}
                >
                  {blockingUrl === l.url ? '…' : l.blocked ? '↩' : '⛔'}
                </button>
                <button
                  onClick={() => deleteLink(l.url)}
                  disabled={deletingUrl === l.url}
                  title="Delete this link from the pool"
                  aria-label="Delete link"
                  className="w-16 shrink-0 text-center text-zinc-500 hover:text-red-400 disabled:opacity-40 transition-colors"
                >
                  {deletingUrl === l.url ? '…' : '🗑'}
                </button>
              </div>
            )
          })
        )}
        </div>
      </div>

      {/* Long-job progress, pinned so it stays visible while the table scrolls.
          Stacked, because a scan and a refresh can legitimately overlap. */}
      {harvestNote && (
        <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400 flex items-center justify-between gap-3">
          <span>🌾 {harvestNote}</span>
          <button onClick={() => setHarvestNote('')} className="text-zinc-600 hover:text-zinc-300 shrink-0">
            dismiss
          </button>
        </div>
      )}

      {historyOpen && <ScanHistory onClose={() => setHistoryOpen(false)} />}

      {(scanning || scanNote || catRunning || catNote || refreshing || refreshNote) && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] flex flex-col items-center gap-2 pointer-events-none">
          {(scanning || scanNote) && (
            <JobBar
              title={scanning ? 'Reading comments…' : 'Comment scan finished'}
              scope={`${matched.toLocaleString()} link${matched === 1 ? '' : 's'}`}
              done={scanDone}
              total={scanTotal}
              note={scanNote}
              colour="bg-sky-500"
              running={scanning}
              onDismiss={() => setScanNote('')}
              onStop={stopScanNow}
            >
              {scanWithOurs > 0 && (
                <div className="text-[11px] text-zinc-500 mt-1.5 tabular-nums">
                  {scanWithOurs.toLocaleString()} link(s) already carry one of our comments
                </div>
              )}
            </JobBar>
          )}
          {(catRunning || catNote) && (
            <JobBar
              title={catRunning ? 'Categorising links…' : 'Categorisation finished'}
              done={catDone}
              total={catTotal}
              note={catNote}
              colour="bg-violet-500"
              running={catRunning}
              onDismiss={() => setCatNote('')}
              onStop={stopCatNow}
            >
              <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[11px]">
                {[
                  ['competitors', 'Competitors', 'text-rose-300'],
                  ['ai_detector', 'AI detector', 'text-amber-300'],
                  ['generic', 'Generic', 'text-zinc-400'],
                ].map(([key, label, tone]) => (
                  <span key={key} className={tone}>
                    {label}:{' '}
                    <span className="tabular-nums">{(catCounts[key] ?? 0).toLocaleString()}</span>
                  </span>
                ))}
              </div>
            </JobBar>
          )}
          {(refreshing || refreshNote) && (
            <JobBar
              title={refreshing ? 'Refreshing like & view counts…' : 'Refresh finished'}
              scope={refreshDays > 0 ? `posted in the last ${refreshDays} days` : 'every post'}
              done={refreshDone}
              total={refreshTotal}
              note={
                refreshNote + (refreshFailed > 0 ? ` · ${refreshFailed.toLocaleString()} unavailable` : '')
              }
              colour="bg-teal-500"
              running={refreshing}
              onDismiss={() => setRefreshNote('')}
              onStop={stopRefreshNow}
            />
          )}
        </div>
      )}

      {/* Pagination */}
      <div className="mt-3">{paginationBar}</div>

      {/* Permanent block list */}
      {blOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 overflow-y-auto"
          onClick={() => !blBusy && setBlOpen(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-5xl my-8"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header: search and sort */}
            <div className="flex flex-wrap items-center gap-2 p-4 border-b border-zinc-800">
              <span className="text-sm font-semibold text-white">
                Blocked links
                <span className="text-zinc-500 font-normal">
                  {' · '}{blMatched.toLocaleString()}{' '}
                  {blByChannel ? 'channel' : 'link'}{blMatched === 1 ? '' : 's'}
                  {blByChannel && blLinkCount > 0 && ` · ${blLinkCount.toLocaleString()} links`}
                  {blQuery ? ' matching' : ''}
                </span>
              </span>
              <input
                value={blQuery}
                onChange={(e) => setBlQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { setBlSel(new Set()); loadBlocked(0, blQuery, blSort, blByChannel) }
                }}
                placeholder="search url or title, then Enter…"
                className="flex-1 min-w-[200px] text-sm text-zinc-100 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-1.5 focus:outline-none focus:border-rose-500"
              />
              <label
                className="flex items-center gap-1.5 text-xs text-zinc-400 shrink-0 cursor-pointer"
                title="One row per channel instead of per link, with how many of its links are blocked."
              >
                <input
                  type="checkbox"
                  checked={blByChannel}
                  onChange={(e) => {
                    const on = e.target.checked
                    setBlByChannel(on)
                    setBlSel(new Set())
                    setBlSelChannels(new Set())
                    loadBlocked(0, blQuery, blSort, on)
                  }}
                  className="accent-rose-500"
                />
                unique channels
              </label>
              <select
                value={blSort}
                onChange={(e) => {
                  const v = e.target.value as 'recent' | 'oldest' | 'url'
                  setBlSort(v); setBlSel(new Set()); loadBlocked(0, blQuery, v, blByChannel)
                }}
                className="text-sm text-zinc-300 bg-zinc-950 border border-zinc-700 rounded-lg px-2 py-1.5"
              >
                <option value="recent">newest blocked</option>
                <option value="oldest">oldest blocked</option>
                <option value="url">by url</option>
              </select>
              <button
                onClick={() => setBlOpen(false)}
                disabled={blBusy}
                className="text-sm text-zinc-400 hover:text-zinc-200 px-2 py-1.5 disabled:opacity-40"
              >
                Close
              </button>
            </div>

            {/* Bulk actions on the selection */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900/60">
              <button
                onClick={() =>
                  blByChannel
                    ? blockAction('unblock', [], Array.from(blSelChannels))
                    : blockAction('unblock', Array.from(blSel))
                }
                disabled={blBusy || (blByChannel ? blSelChannels.size === 0 : blSel.size === 0)}
                className="text-sm text-emerald-200 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 disabled:opacity-40 rounded-lg px-3 py-1.5 transition-colors"
              >
                {blBusy
                  ? 'Working…'
                  : blByChannel
                    ? `✓ Unblock selected channel${blSelChannels.size === 1 ? '' : 's'}${blSelChannels.size ? ` (${blSelChannels.size})` : ''}`
                    : `✓ Unblock selected${blSel.size ? ` (${blSel.size.toLocaleString()})` : ''}`}
              </button>
              <button
                onClick={() =>
                  blByChannel
                    ? setBlSelChannels(new Set(blChannels.map((c) => c.handle)))
                    : setBlSel(new Set(blRows.map((r) => r.url)))
                }
                disabled={blBusy || (blByChannel ? blChannels.length === 0 : blRows.length === 0)}
                className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-2.5 py-1.5 disabled:opacity-40"
              >
                Select page ({blByChannel ? blChannels.length : blRows.length})
              </button>
              <button
                onClick={selectAllMatching}
                disabled={blBusy || blMatched === 0 || blByChannel}
                title="Select every link matching the current search, not just the rows on this page."
                className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-2.5 py-1.5 disabled:opacity-40"
              >
                Select all {blMatched.toLocaleString()} matching
              </button>
              <button
                onClick={() => { setBlSel(new Set()); setBlSelChannels(new Set()) }}
                disabled={blBusy || (blSel.size === 0 && blSelChannels.size === 0)}
                className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1.5 disabled:opacity-40"
              >
                Clear selection
              </button>
              {blNote && <span className="text-xs text-zinc-400 ml-auto">{blNote}</span>}
            </div>

            {/* Rows */}
            <div className="max-h-[60vh] overflow-y-auto">
              <div className="flex items-center gap-3 px-4 py-1.5 text-[11px] text-zinc-500 border-b border-zinc-800 sticky top-0 bg-zinc-900">
                <span className="w-5 shrink-0" />
                <span className="w-24 shrink-0">blocked</span>
                {blByChannel ? (
                  <span className="w-16 shrink-0 text-right">links</span>
                ) : (
                  <span className="w-16 shrink-0 text-center">in pool</span>
                )}
                <span className="flex-1 min-w-0">{blByChannel ? 'channel' : 'link / title'}</span>
                <span className="w-10 shrink-0" />
              </div>
              {blLoading ? (
                <div className="p-6 text-center text-sm text-zinc-500">Loading…</div>
              ) : blByChannel ? (
                blChannels.length === 0 ? (
                  <div className="p-6 text-center text-sm text-zinc-500">
                    {blQuery ? 'No channel matches that search.' : 'No blocked links have a channel.'}
                  </div>
                ) : (
                  blChannels.map((c) => {
                    const on = blSelChannels.has(c.handle)
                    return (
                      <div
                        key={c.handle}
                        className={`flex items-center gap-3 px-4 py-1.5 text-xs border-b border-zinc-800/50 ${on ? 'bg-rose-600/10' : 'hover:bg-zinc-800/40'}`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const next = new Set(blSelChannels)
                            if (on) next.delete(c.handle)
                            else next.add(c.handle)
                            setBlSelChannels(next)
                          }}
                          className="w-5 shrink-0 accent-rose-500"
                        />
                        <span className="w-24 shrink-0 text-zinc-500 tabular-nums">
                          {new Date(c.lastBlocked).toLocaleDateString()}
                        </span>
                        <span
                          className="w-16 shrink-0 text-right text-rose-300 tabular-nums"
                          title={`${c.blocked.toLocaleString()} of this channel's links are blocked`}
                        >
                          {c.blocked.toLocaleString()}
                        </span>
                        <span className="flex-1 min-w-0">
                          <a
                            href={`https://www.tiktok.com/@${c.handle}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-zinc-300 hover:text-rose-300"
                          >
                            @{c.handle}
                          </a>
                          <a
                            href={c.sampleUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-[11px] text-zinc-600 hover:text-zinc-400"
                          >
                            {c.sampleUrl}
                          </a>
                        </span>
                        <button
                          onClick={() => blockAction('unblock', [], [c.handle])}
                          disabled={blBusy}
                          title={`Unblock all ${c.blocked.toLocaleString()} blocked link(s) of this channel`}
                          className="w-10 shrink-0 text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                        >
                          ✓
                        </button>
                      </div>
                    )
                  })
                )
              ) : blRows.length === 0 ? (

                <div className="p-6 text-center text-sm text-zinc-500">
                  {blQuery ? 'Nothing matches that search.' : 'The block list is empty.'}
                </div>
              ) : (
                blRows.map((r) => {
                  const on = blSel.has(r.url)
                  return (
                    <div
                      key={r.url}
                      className={`flex items-center gap-3 px-4 py-1.5 text-xs border-b border-zinc-800/50 ${on ? 'bg-rose-600/10' : 'hover:bg-zinc-800/40'}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          const next = new Set(blSel)
                          if (on) next.delete(r.url)
                          else next.add(r.url)
                          setBlSel(next)
                        }}
                        className="w-5 shrink-0 accent-rose-500"
                      />
                      <span className="w-24 shrink-0 text-zinc-500 tabular-nums">
                        {new Date(r.blockedAt).toLocaleDateString()}
                      </span>
                      <span
                        className="w-16 shrink-0 text-center"
                        title={
                          r.inPool
                            ? 'Still in the pool — unblocking puts it straight back into circulation.'
                            : 'No longer in the pool — unblocking only lifts the filter; it comes back only if an upload re-adds it.'
                        }
                      >
                        {r.inPool ? (
                          <span className="text-emerald-400">yes</span>
                        ) : (
                          <span className="text-zinc-600">no</span>
                        )}
                      </span>
                      <span className="flex-1 min-w-0">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-zinc-300 hover:text-rose-300"
                        >
                          {r.url}
                        </a>
                        {r.title && (
                          <span className="block truncate text-[11px] text-zinc-600">{r.title}</span>
                        )}
                      </span>
                      <button
                        onClick={() => blockAction('unblock', [r.url])}
                        disabled={blBusy}
                        title="Unblock just this link"
                        className="w-10 shrink-0 text-emerald-400 hover:text-emerald-300 disabled:opacity-40"
                      >
                        ✓
                      </button>
                    </div>
                  )
                })
              )}
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between gap-3 p-3 border-t border-zinc-800">
              <button
                onClick={() => loadBlocked(Math.max(0, blOffset - BLOCKED_PAGE), blQuery, blSort, blByChannel)}
                disabled={blLoading || blOffset === 0}
                className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-3 py-1.5 disabled:opacity-30"
              >
                ← Previous
              </button>
              <span className="text-xs text-zinc-500 tabular-nums">
                {blMatched === 0
                  ? '0'
                  : `${(blOffset + 1).toLocaleString()}–${Math.min(blOffset + blRows.length, blMatched).toLocaleString()}`}
                {' of '}{blMatched.toLocaleString()}
                {blSel.size > 0 && ` · ${blSel.size.toLocaleString()} selected`}
              </span>
              <button
                onClick={() => loadBlocked(blOffset + BLOCKED_PAGE, blQuery, blSort, blByChannel)}
                disabled={blLoading || blOffset + BLOCKED_PAGE >= blMatched}
                className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-3 py-1.5 disabled:opacity-30"
              >
                Next →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Posted-date weight modal (opened by "🧮 Recluster links") */}
      {reclusterOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !reclustering && setReclusterOpen(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-white mb-1">Posted-date cluster weights</div>
            <div className="text-xs text-zinc-500 mb-4 leading-relaxed">
              How the <span className="text-zinc-300">Posted date</span> clusters are ranked. Each
              signal is a percentile across the pool, so these are shares of one score — they don&apos;t
              have to add up to 100, only the ratio between them matters.
            </div>

            {weightsLoading ? (
              <div className="text-xs text-zinc-500 py-6 text-center">Loading current weights…</div>
            ) : (
              <div className="space-y-3 mb-4">
                {WEIGHT_FIELDS.map(({ key, label, hint }) => (
                  <div key={key}>
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <label htmlFor={`w-${key}`} className="text-sm text-zinc-200">{label}</label>
                      <span className="text-xs text-zinc-500 tabular-nums">
                        {weightTotal > 0
                          ? `${((100 * weights[key]) / weightTotal).toFixed(1)}% of the score`
                          : '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={weights[key]}
                        onChange={(e) => setWeights((w) => ({ ...w, [key]: Number(e.target.value) }))}
                        className="flex-1 accent-teal-500"
                        aria-label={label}
                      />
                      <input
                        id={`w-${key}`}
                        type="number"
                        min={0}
                        step={1}
                        value={weights[key]}
                        onChange={(e) => {
                          const n = Number(e.target.value)
                          setWeights((w) => ({ ...w, [key]: Number.isFinite(n) && n >= 0 ? n : 0 }))
                        }}
                        className="w-16 text-sm text-right text-zinc-100 bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 tabular-nums"
                      />
                    </div>
                    <div className="text-xs text-zinc-600 mt-0.5">{hint}</div>
                  </div>
                ))}
              </div>
            )}

            {/* A total other than 100 is fine — say so, rather than blocking on it. */}
            <div className="text-xs mb-4">
              {weightTotal <= 0 ? (
                <span className="text-amber-400">
                  All three are zero — set at least one above 0.
                </span>
              ) : Math.round(weightTotal) === 100 ? (
                <span className="text-zinc-500">Total 100.</span>
              ) : (
                <span className="text-zinc-500">
                  Total {weightTotal.toLocaleString()} — will be scaled to 100 (
                  {WEIGHT_FIELDS.map(({ key }) => ((100 * weights[key]) / weightTotal).toFixed(0)).join(' / ')}
                  ).
                </span>
              )}
            </div>

            <div className="text-xs text-zinc-500 mb-4 leading-relaxed">
              Rescores every link that isn&apos;t blocked and rewrites videos.json. Blocked links are
              left untouched. This changes the order links are served in, not the links themselves.
              New uploads will use these weights too.
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={recluster}
                disabled={reclustering || weightsLoading || weightTotal <= 0}
                className="flex-1 text-sm text-white bg-teal-600 hover:bg-teal-500 disabled:opacity-40 rounded-lg px-3 py-2 transition-colors"
              >
                {reclustering ? 'Reclustering…' : '🧮 Save & recluster'}
              </button>
              <button
                onClick={() => setWeights(DEFAULT_WEIGHTS)}
                disabled={reclustering}
                title="Back to 60 / 30 / 10"
                className="text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg px-3 py-2 disabled:opacity-40"
              >
                Defaults
              </button>
              <button
                onClick={() => setReclusterOpen(false)}
                disabled={reclustering}
                className="text-sm text-zinc-400 hover:text-zinc-200 rounded-lg px-3 py-2 disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Review decision modal (opened by clicking a link while "Marked unrelated only") */}
      {reviewLink && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setReviewLink(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-sm w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-white mb-1">Review flagged link</div>
            <div className="text-xs text-zinc-500 break-all mb-2">{reviewLink.url}</div>
            <div className="text-xs text-zinc-500 mb-4">
              {reviewLink.unrelated} user(s) marked this unrelated. It opened in a new tab — decide what to do:
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { clearUnrelated(reviewLink.url); setReviewLink(null) }}
                className="w-full text-sm text-emerald-300 border border-emerald-600/40 bg-emerald-600/10 hover:bg-emerald-600/20 rounded-lg px-3 py-2 transition-colors"
              >
                ✓ It&apos;s fine — clear the unrelated flag
              </button>
              <button
                onClick={() => { setBlocked(reviewLink.url, true, true); setReviewLink(null) }}
                className="w-full text-sm text-rose-200 border border-rose-500/40 bg-rose-600/20 hover:bg-rose-600/30 rounded-lg px-3 py-2 transition-colors"
              >
                ⛔ It&apos;s unrelated — block the link forever
              </button>
              <button
                onClick={() => setReviewLink(null)}
                className="w-full text-sm text-zinc-400 hover:text-zinc-200 rounded-lg px-3 py-2"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
