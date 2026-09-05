'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/auth-client'
import {
  RANK_CLUSTER_COUNT,
  DATE_CLUSTER_COUNT,
  HOURLY_LINK_LIMIT,
  HOURLY_WINDOW_MS,
  PLATFORM_ROTATE_MS,
  REMINDER_CLICKS,
} from '@/lib/config'
import { pickDimension, seedFrom } from '@/lib/clusterMix'
import FinishButton from '@/components/FinishButton'
import EditAccountLinks from '@/components/EditAccountLinks'
import type { UserMessage, PendingPayments, ApkInfo, UserProfile } from '@/lib/db'

// Birr formatting: no trailing ".00", up to 2 decimals otherwise.
function fmtBirr(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

export type Platform = 'tiktok' | 'youtube_shorts' | 'youtube_videos' | 'instagram'

export interface Video {
  url: string
  platform: Platform | 'unknown'
  author: string
  video_id: string
  like_count: number
  posted_date: string
  scraped_at: string
  search_query: string
  search_rank: number
  source_file: string
  /** Composite posted-date score set at upload (lib/dateScore.ts). */
  date_score?: number
}

interface UserInfo {
  name: string
  email: string
  image: string | null
}

// The platform tabs (no "All"), in rotation order, with label + dot colour.
const PLATFORMS: { key: Platform; label: string; dot: string; text: string }[] = [
  { key: 'tiktok', label: 'TikTok', dot: 'bg-pink-500', text: 'text-emerald-400' },
  { key: 'youtube_shorts', label: 'YT Shorts', dot: 'bg-orange-500', text: 'text-orange-400' },
  { key: 'youtube_videos', label: 'YT Videos', dot: 'bg-red-500', text: 'text-red-400' },
  { key: 'instagram', label: 'Instagram', dot: 'bg-fuchsia-500', text: 'text-fuchsia-400' },
]

// Future platforms — shown as disabled tabs (not yet wired up). Work in progress.
const COMING_SOON_PLATFORMS: { label: string }[] = [
  { label: 'Reddit' },
  { label: 'X' },
  { label: 'Blog Post' },
]

// Platforms whose links have no posted_date, so only rank clustering makes sense.
const RANK_ONLY_PLATFORMS = new Set<Platform>(['instagram'])

function platformDot(p: string): string {
  const found = PLATFORMS.find((x) => x.key === p)
  return found ? found.dot : 'bg-zinc-600'
}

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toLocaleString()
}

/**
 * Normalise a scraped posted_date into an epoch-ms timestamp, or null if it
 * can't be parsed. Handles TikTok/YouTube formats:
 *   - relative words:   "3 days ago", "2 weeks ago", "1 year ago", "today"
 *   - relative abbrev:  "16h ago", "2d ago", "1w ago", "30s ago", "3mo ago"
 *   - absolute:         "2023-5-12", "2023/5/12", "5-12" (year-less), ISO
 * Relative dates are resolved against scraped_at.
 */
export function parsePostedDate(raw: string, scrapedAt: string): number | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  const base = Date.parse(scrapedAt) || Date.now()

  if (s === 'just now' || s === 'today') return base
  if (s === 'yesterday') return base - 86_400_000

  const rel = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unitMs: Record<string, number> = {
      second: 1_000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_629_800_000, // avg month
      year: 31_557_600_000, // avg year
    }
    return base - n * (unitMs[rel[2]] ?? 0)
  }

  // Abbreviated relative (TikTok): "16h ago", "2d ago", "1w ago", "30s ago",
  // "5m ago" (minutes), "3mo ago" (months), "1y ago". 'mo' must precede 'm'.
  const relAbbr = s.match(/^(\d+)\s*(mo|s|m|h|d|w|y)\s*ago$/)
  if (relAbbr) {
    const n = parseInt(relAbbr[1], 10)
    const abbrMs: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
      mo: 2_629_800_000,
      y: 31_557_600_000,
    }
    return base - n * (abbrMs[relAbbr[2]] ?? 0)
  }

  // YYYY-M-D or YYYY/M/D
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3])

  // M-D or M/D (year-less, common on TikTok) → assume the scrape year,
  // rolling back one year if that date would be in the future.
  m = s.match(/^(\d{1,2})[-/](\d{1,2})$/)
  if (m) {
    const y = new Date(base).getUTCFullYear()
    let t = Date.UTC(y, +m[1] - 1, +m[2])
    if (t > base + 86_400_000) t = Date.UTC(y - 1, +m[1] - 1, +m[2])
    return t
  }

  const parsed = Date.parse(raw)
  return isNaN(parsed) ? null : parsed
}

function fmtDate(ts: number) {
  return new Date(ts).toISOString().slice(0, 10)
}

function fmtDuration(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// An admin message banner with a reply box.
function MessageBanner({ m, onDismiss }: { m: UserMessage; onDismiss: () => void }) {
  const [replying, setReplying] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [replied, setReplied] = useState(false)

  async function sendReply() {
    if (!text.trim()) return
    setSending(true)
    try {
      const res = await fetch('/api/messages/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: m.id, body: text.trim() }),
      })
      if (res.ok) {
        setReplied(true)
        setReplying(false)
        setText('')
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none">📢</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-emerald-100 whitespace-pre-wrap break-words">{m.body}</p>
          <p className="text-[11px] text-emerald-300/60 mt-0.5">
            Message from admin · {m.created_at.slice(0, 10)}
          </p>
          <div className="mt-1.5">
            {replied ? (
              <span className="text-[11px] text-emerald-400">Replied ✓</span>
            ) : (
              <button
                onClick={() => setReplying((v) => !v)}
                className="text-[11px] text-emerald-300 hover:text-white"
              >
                {replying ? 'Cancel' : 'Reply'}
              </button>
            )}
          </div>
          {replying && (
            <div className="mt-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={2}
                placeholder="Write a reply to the admin…"
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
              />
              <div className="flex justify-end mt-1.5">
                <button
                  onClick={sendReply}
                  disabled={sending || !text.trim()}
                  className="text-xs text-white bg-emerald-600 hover:bg-emerald-500 rounded px-3 py-1 disabled:opacity-50"
                >
                  {sending ? 'Sending…' : 'Send reply'}
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="text-emerald-200/70 hover:text-white text-sm shrink-0"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

/**
 * Persist a click to the DB, retrying so a transient failure doesn't lose it.
 * Falls back to sendBeacon (which survives the tab unloading) as a last resort.
 */
async function persistClick(
  url: string,
  searchQuery: string,
  platform: string,
  product: string | null
): Promise<void> {
  const body = JSON.stringify({ url, search_query: searchQuery, platform, product })
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch('/api/clicks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
      if (res.ok) return
      if (res.status === 429) return // hourly limit — not retryable
    } catch {
      /* network error — retry below */
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
  }
  try {
    navigator.sendBeacon?.('/api/clicks', new Blob([body], { type: 'application/json' }))
  } catch {
    /* nothing more we can do */
  }
}

interface Cluster {
  label: string
  range: string
  items: Video[]
}

/**
 * One link row.
 *
 * PERFORMANCE: this MUST stay at module scope. Defined inside Dashboard it would
 * be a new component type on every render, so React would unmount and re-mount
 * every row in the list — and Dashboard re-renders once a SECOND (the countdown
 * clock and the shuffle timer). With a few thousand links that rebuilt the whole
 * list DOM every tick, which is what made clicking feel slow.
 */
const LinkRow = memo(function LinkRow({ v, onOpen }: { v: Video; onOpen: (v: Video) => void }) {
  const ts = parsePostedDate(v.posted_date, v.scraped_at)
  return (
    // content-visibility:auto lets the browser skip layout/paint for rows that are
    // scrolled out of view — with thousands of links that is most of them. The
    // intrinsic-size hint keeps the scrollbar honest; `auto` means the browser
    // remembers each row's real height once it has been rendered, so wrapped
    // (long) URLs don't cause scroll jumps.
    <div className="flex items-center gap-3 group py-2 sm:py-1 [content-visibility:auto] [contain-intrinsic-size:auto_32px]">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${platformDot(v.platform)}`} />
      {v.search_rank > 0 && (
        <span
          className="text-zinc-500 text-xs tabular-nums shrink-0"
          title={`search rank for "${v.search_query}"`}
        >
          #{v.search_rank}
        </span>
      )}
      <a
        href={v.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          e.preventDefault()
          onOpen(v)
        }}
        className="text-zinc-300 hover:text-emerald-400 text-sm break-all transition-colors group-hover:underline min-w-0"
      >
        {v.url}
      </a>
      {ts !== null && (
        <span className="text-zinc-600 text-xs shrink-0 tabular-nums" title={v.posted_date}>
          {fmtDate(ts)}
        </span>
      )}
      {v.like_count > 0 && <span className="text-zinc-600 text-xs shrink-0">{fmt(v.like_count)}</span>}
    </div>
  )
})

/**
 * The whole cluster list. Memoized so the once-a-second clock tick in Dashboard
 * doesn't even diff the thousands of rows below it — this subtree only re-renders
 * when `clusters` actually changes (a click, a filter, a shuffle). `onOpen` must
 * be referentially stable for that to hold; Dashboard passes a ref-backed one.
 */
const ClusterList = memo(function ClusterList({
  clusters,
  onOpen,
}: {
  clusters: Cluster[]
  onOpen: (v: Video) => void
}) {
  return (
    <div className="space-y-6">
      {clusters.map((c, ci) => (
        <div key={ci}>
          <div className="flex items-baseline gap-2 mb-2 pb-1 border-b border-zinc-800">
            <h2 className="text-sm font-semibold text-emerald-400">{c.label}</h2>
            <span className="text-xs text-zinc-500">{c.range}</span>
            <span className="text-xs text-zinc-600 ml-auto">{c.items.length.toLocaleString()} links</span>
          </div>
          <div className="space-y-1">
            {c.items.map((v) => (
              <LinkRow key={v.url} v={v} onOpen={onOpen} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
})

type GroupBy = 'rank' | 'date'

export default function Dashboard({
  videos,
  clickedUrls,
  retiredUrls,
  dateShare,
  todayCounts,
  hourly,
  firstLogin,
  messages,
  pendingPay,
  paidNotice,
  apk,
  showClickedToday,
  user,
  profile,
  product,
  limits,
}: {
  videos: Video[]
  clickedUrls: string[]
  retiredUrls: string[]
  /** Percent of workers put on the posted-date clustering; set on the admin
   *  Links page. The rest work from search rank. */
  dateShare: number
  todayCounts: Record<string, number>
  hourly: Record<string, number[]>
  firstLogin: boolean
  messages: UserMessage[]
  pendingPay: PendingPayments | null
  paidNotice: number | null
  apk: ApkInfo | null
  showClickedToday: boolean
  user: UserInfo
  profile: UserProfile | null
  product: string | null
  limits: Record<string, { limit: number; windowMs: number }>
}) {
  // Per-platform quota rule with a safe default fallback.
  const limitOf = (p: string): number => limits?.[p]?.limit ?? HOURLY_LINK_LIMIT
  const windowOf = (p: string): number => limits?.[p]?.windowMs ?? HOURLY_WINDOW_MS
  const router = useRouter()
  // Warm the task pages as soon as the dashboard loads, so tapping Comments /
  // Video task / Repost & earn navigates from cache instantly (a full prefetch,
  // not just the loading spinner — important since these routes are dynamic).
  useEffect(() => {
    for (const href of ['/videos', '/promo']) router.prefetch(href)
  }, [router])

  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState<Platform>('tiktok')
  const [groupBy, setGroupBy] = useState<GroupBy>('rank')
  // Admin messages the user hasn't dismissed yet.
  const [msgs, setMsgs] = useState<UserMessage[]>(() => messages)
  function dismissMsg(id: number) {
    setMsgs((prev) => prev.filter((m) => m.id !== id))
    fetch('/api/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {})
  }

  // Instagram links have no date → force rank clustering (and hide the date tab).
  const supportsDate = !RANK_ONLY_PLATFORMS.has(platform)
  const effGroupBy: GroupBy = supportsDate ? groupBy : 'rank'
  const clusterTabs: [GroupBy, string][] = supportsDate
    ? [['rank', 'Search rank'], ['date', 'Posted date']]
    : [['rank', 'Search rank']]

  // URLs this user has opened — hidden from them from now on.
  const [clicked, setClicked] = useState<Set<string>>(() => new Set(clickedUrls))
  // Today's click counts per platform (seeded from the server, bumped live).
  const [today, setToday] = useState<Record<string, number>>(() => ({ ...todayCounts }))
  // Rolling hourly quota: click timestamps (ms) per platform in the last hour.
  const [hourlyTimes, setHourlyTimes] = useState<Record<string, number[]>>(() => ({ ...hourly }))
  const hourlyRef = useRef<Record<string, number[]>>({ ...hourly })
  // The shared cross-product comment pool (same one the app uses). Each entry is
  // paired with the product it advertises so a click can be attributed to the
  // comment we actually put on the clipboard — that is the ONLY thing per-product
  // click counts measure, since users aren't assigned to a product.
  const poolRef = useRef<{ text: string; product: string | null }[]>([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/comments', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d || !Array.isArray(d.comments)) return
        const products: unknown[] = Array.isArray(d.commentProducts) ? d.commentProducts : []
        poolRef.current = d.comments.map((text: unknown, i: number) => ({
          text: String(text),
          product: typeof products[i] === 'string' && products[i] ? String(products[i]) : null,
        }))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // A per-second clock so lock states and countdowns update live.
  const [nowMs, setNowMs] = useState(0)
  useEffect(() => {
    setNowMs(Date.now())
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Rolling-window helpers (a click counts while it's younger than the platform's
  // configured wait window).
  const recentCount = (p: string): number => {
    const arr = hourlyTimes[p]
    if (!arr || !nowMs) return arr ? arr.length : 0
    const win = windowOf(p)
    return arr.reduce((n, t) => n + (nowMs - t < win ? 1 : 0), 0)
  }
  const isLocked = (p: string): boolean => {
    const lim = limitOf(p)
    return lim > 0 && recentCount(p) >= lim
  }
  const resetAtOf = (p: string): number | null => {
    const lim = limitOf(p)
    if (lim <= 0) return null // unlimited → never locked
    const win = windowOf(p)
    const arr = (hourlyTimes[p] || []).filter((t) => (nowMs || Date.now()) - t < win)
    if (arr.length < lim) return null
    const sorted = [...arr].sort((a, b) => a - b)
    // The click that must age out for the count to drop below the limit.
    return sorted[arr.length - lim] + win
  }
  // Clicks made in this session; the first REMINDER_CLICKS show a confirm dialog.
  const [sessionClicks, setSessionClicks] = useState(0)
  const [pending, setPending] = useState<Video | null>(null)
  // Transient banner shown when a platform hits its hourly limit.
  const [lockNotice, setLockNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!lockNotice) return
    const id = setTimeout(() => setLockNotice(null), 12000)
    return () => clearTimeout(id)
  }, [lockNotice])

  // Auto-rotate the active platform tab every PLATFORM_ROTATE_MS, unless the user
  // picked a tab manually (then skip the very next rotation only).
  const skipNextRotateRef = useRef(false)
  useEffect(() => {
    const id = setInterval(() => {
      if (skipNextRotateRef.current) {
        skipNextRotateRef.current = false
        return
      }
      setPlatform((prev) => {
        const idx = PLATFORMS.findIndex((p) => p.key === prev)
        return PLATFORMS[(idx + 1) % PLATFORMS.length].key
      })
    }, PLATFORM_ROTATE_MS)
    return () => clearInterval(id)
  }, [])

  // Day-aware default tab: the FIRST dashboard open of the day lands on TikTok.
  // Later opens the same day restore the last tab you were on, so normal
  // switching/rotation isn't overridden. Persisted per user in localStorage.
  // The "day" boundary is UTC, matching the daily click counter.
  const tabInitRef = useRef(false)
  useEffect(() => {
    const key = `activeTab:${user.email || 'anon'}`
    const today = new Date().toISOString().slice(0, 10) // UTC YYYY-MM-DD
    let restored: Platform | null = null
    try {
      const raw = localStorage.getItem(key)
      const saved = raw ? JSON.parse(raw) : null
      if (saved && saved.day === today && PLATFORMS.some((p) => p.key === saved.platform)) {
        restored = saved.platform as Platform
      }
    } catch {
      /* ignore storage errors */
    }
    if (restored) {
      setPlatform(restored) // subsequent open today → keep last tab
    } else {
      setPlatform('tiktok') // first open of the day (or new day) → TikTok
      try {
        localStorage.setItem(key, JSON.stringify({ day: today, platform: 'tiktok' }))
      } catch {
        /* ignore */
      }
    }
    tabInitRef.current = true
  }, [user.email])

  // Remember the active tab (with today's date) whenever it changes.
  useEffect(() => {
    if (!tabInitRef.current) return
    try {
      const key = `activeTab:${user.email || 'anon'}`
      const today = new Date().toISOString().slice(0, 10)
      localStorage.setItem(key, JSON.stringify({ day: today, platform }))
    } catch {
      /* ignore */
    }
  }, [platform, user.email])

  // Which clustering this user works from. A weighted draw, not a clock: the
  // admin sets what share of links should come from the posted-date clustering
  // (default 75%) on the Links page, and each user is assigned a side with that
  // probability. The app blends the two per link; a page of grouped clusters
  // cannot show a blend, so the web picks one side per user.
  //
  // Seeded by the user, so it is the SAME every time they open the page. A fresh
  // draw per load would put them back where the five-minute schedule had them —
  // the list changing under them for reasons they cannot see.
  //
  // Manual tab clicks still win, for as long as the page is open.
  const pickedRef = useRef(false)
  useEffect(() => {
    if (pickedRef.current) return
    pickedRef.current = true
    setGroupBy(pickDimension(seedFrom(user.email || ''), dateShare))
  }, [user.email, dateShare])

  // Links retired globally (clicked by >= RETIRE_AFTER_USERS distinct users) as of
  // page load — hidden from everyone, even users who never clicked them.
  const retired = useMemo(() => new Set(retiredUrls), [retiredUrls])

  const available = useMemo(
    () => videos.filter((v) => !clicked.has(v.url) && !retired.has(v.url)),
    [videos, clicked, retired]
  )

  const availableByPlatform = useMemo(() => {
    const m: Record<string, number> = { tiktok: 0, youtube_shorts: 0, youtube_videos: 0, instagram: 0 }
    for (const v of available) m[v.platform] = (m[v.platform] ?? 0) + 1
    return m
  }, [available])

  // A platform is "workable" if it isn't at its hourly cap and still has links.
  const isWorkable = (p: string) => !isLocked(p) && (availableByPlatform[p] ?? 0) > 0
  const firstWorkablePlatform = (from: Platform): Platform | null => {
    const order = PLATFORMS.map((p) => p.key)
    const start = order.indexOf(from)
    for (let i = 1; i <= order.length; i++) {
      const cand = order[(start + i) % order.length]
      if (isWorkable(cand)) return cand
    }
    return isWorkable(from) ? from : null
  }

  // When the active platform is locked (hourly cap) or empty, switch to another
  // platform that still has quota + links — until they're all finished.
  useEffect(() => {
    if (isWorkable(platform)) return
    const next = firstWorkablePlatform(platform)
    if (next && next !== platform) setPlatform(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, nowMs, availableByPlatform, hourlyTimes])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return available.filter((v) => {
      if (v.platform !== platform) return false
      if (q) {
        return (
          v.url.toLowerCase().includes(q) ||
          v.author.toLowerCase().includes(q) ||
          (v.search_query || '').toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [available, search, platform])

  // Freeze each link's cluster once, from the platform's FULL set (not the current
  // filtered set), so cluster membership doesn't rebalance as links are removed.
  const clusterAssignment = useMemo(() => {
    const n = Math.max(1, effGroupBy === 'rank' ? RANK_CLUSTER_COUNT : DATE_CLUSTER_COUNT)
    const map = new Map<string, number>()
    // Where each link sits in the clustering score's own order. Kept because the
    // cluster index alone does not say that: two links in cluster 3 still have
    // a better and a worse score, and that is the order they are served in.
    const pos = new Map<string, number>()
    const base = videos.filter((v) => v.platform === platform)
    if (effGroupBy === 'rank') {
      const ranked = base
        .filter((v) => v.search_rank > 0)
        .sort((a, b) => a.search_rank - b.search_rank)
      ranked.forEach((v, idx) => {
        map.set(v.url, ranked.length ? Math.min(n - 1, Math.floor((idx * n) / ranked.length)) : 0)
        pos.set(v.url, idx)
      })
      base.filter((v) => !(v.search_rank > 0)).forEach((v) => map.set(v.url, -1))
    } else {
      // Rank by the composite posted-date score when the pool carries one
      // (recency + video + hearts, computed at upload); otherwise
      // fall back to plain recency so older pools still cluster.
      const useScore = base.some((v) => typeof v.date_score === 'number')
      const dated = base
        .map((v) => ({
          v,
          ts: useScore
            ? typeof v.date_score === 'number'
              ? v.date_score
              : null
            : parsePostedDate(v.posted_date, v.scraped_at),
        }))
        .filter((x): x is { v: Video; ts: number } => x.ts !== null)
        .sort((a, b) => b.ts - a.ts) // best first
      dated.forEach((x, idx) => {
        map.set(x.v.url, dated.length ? Math.min(n - 1, Math.floor((idx * n) / dated.length)) : 0)
        pos.set(x.v.url, idx)
      })
      // The "Unknown date" bucket must use the SAME key as the clustering above,
      // or a scored link with no readable posted_date would be clustered AND then
      // overwritten as unknown. With scoring on, only an unscored link is unknown.
      base
        .filter((v) =>
          useScore
            ? typeof v.date_score !== 'number'
            : parsePostedDate(v.posted_date, v.scraped_at) === null
        )
        .forEach((v) => map.set(v.url, -1))
    }
    return { map, pos }
  }, [videos, effGroupBy, platform])

  const clusters = useMemo<Cluster[]>(() => {
    const n = Math.max(1, effGroupBy === 'rank' ? RANK_CLUSTER_COUNT : DATE_CLUSTER_COUNT)
    const buckets: Video[][] = Array.from({ length: n }, () => [])
    const special: Video[] = []
    for (const v of filtered) {
      const ci = clusterAssignment.map.get(v.url)
      if (ci === undefined || ci < 0) special.push(v)
      else buckets[ci].push(v)
    }

    const rangeOf = (items: Video[]): string => {
      if (!items.length) return '—'
      if (effGroupBy === 'rank') {
        let lo = Infinity
        let hi = -Infinity
        for (const v of items) {
          if (v.search_rank < lo) lo = v.search_rank
          if (v.search_rank > hi) hi = v.search_rank
        }
        return `rank #${lo} – #${hi}`
      }
      let newest = -Infinity
      let oldest = Infinity
      for (const v of items) {
        const ts = parsePostedDate(v.posted_date, v.scraped_at)
        if (ts === null) continue
        if (ts > newest) newest = ts
        if (ts < oldest) oldest = ts
      }
      return newest === -Infinity ? '—' : `${fmtDate(newest)} → ${fmtDate(oldest)}`
    }

    // Within a cluster: the clustering score, and nothing else — best search
    // rank first, or highest date score first, whichever dimension is active.
    //
    // Two other orderings used to sit on top of this and both are gone. A
    // per-window shuffle handed the same score's links to every user in a
    // different order, and a sort by distinct clicks floated "under-clicked"
    // links to the top — which counted who had OPENED a link rather than what
    // was on it. A link's place is now decided by the one number that put it in
    // its cluster, so every user sees the same queue.
    const orderCluster = (items: Video[]): Video[] =>
      [...items].sort(
        (a, b) =>
          (clusterAssignment.pos.get(a.url) ?? Number.MAX_SAFE_INTEGER) -
          (clusterAssignment.pos.get(b.url) ?? Number.MAX_SAFE_INTEGER)
      )

    const out: Cluster[] = buckets
      .map((items, i) => ({
        label: `Cluster ${i + 1}`,
        range: rangeOf(items),
        items: orderCluster(items),
      }))
      .filter((c) => c.items.length)

    if (special.length) {
      out.push({
        label: effGroupBy === 'rank' ? 'Unranked' : 'Unknown date',
        range: effGroupBy === 'rank' ? 'no search rank' : 'unparseable',
        items: orderCluster(special),
      })
    }
    return out
  }, [filtered, effGroupBy, clusterAssignment])

  function proceed(v: Video) {
    // Pick and copy a comment BEFORE anything else, so the click can be recorded
    // against the product we actually served. The clipboard write must happen in
    // the click handler itself — browsers only allow it during a user gesture.
    const pool = poolRef.current
    const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    if (pick) {
      try {
        void navigator.clipboard?.writeText(pick.text)
      } catch {
        /* clipboard blocked — the click still counts for this product */
      }
    }
    window.open(v.url, '_blank', 'noopener,noreferrer')
    setClicked((prev) => {
      const next = new Set(prev)
      next.add(v.url)
      return next
    })
    setToday((prev) => ({ ...prev, [v.platform]: (prev[v.platform] ?? 0) + 1 }))
    // Track this click against the platform's rolling quota window.
    const now = Date.now()
    const win = windowOf(v.platform)
    const lim = limitOf(v.platform)
    const prevArr = (hourlyRef.current[v.platform] || []).filter((t) => now - t < win)
    const nextArr = [...prevArr, now]
    hourlyRef.current = { ...hourlyRef.current, [v.platform]: nextArr }
    setHourlyTimes(hourlyRef.current)
    // Just hit the cap for this platform → tell the user.
    if (lim > 0 && nextArr.length === lim) {
      const label = PLATFORMS.find((p) => p.key === v.platform)?.label ?? v.platform
      setLockNotice(
        `You've opened ${lim} ${label} link${lim === 1 ? '' : 's'} within the limit window — that's the cap. ` +
          `${label} is now locked (see the countdown on its tab), and you'll be moved to another platform that still has links.`
      )
    }
    // Register the click server-side, with retries so it's never silently lost.
    void persistClick(v.url, v.search_query, v.platform, pick?.product ?? null)
  }

  // handleOpen closes over state that changes every second (the clock, the
  // rolling quota), so its identity is useless as a memo dep. Keep the latest
  // implementation in a ref and hand the list a callback that never changes.
  const handleOpenRef = useRef<(v: Video) => void>(() => {})
  const onOpen = useCallback((v: Video) => handleOpenRef.current(v), [])

  function handleOpen(v: Video) {
    if (isLocked(v.platform)) return // platform at its hourly limit
    // The "will be removed" reminder is only for a brand-new user's first login.
    if (firstLogin && sessionClicks < REMINDER_CLICKS) {
      setPending(v) // show the reminder dialog
    } else {
      proceed(v)
    }
  }

  useEffect(() => {
    handleOpenRef.current = handleOpen
  })

  const todayTotal = PLATFORMS.reduce((sum, p) => sum + (today[p.key] ?? 0), 0)

  const header = (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/videos"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 shadow-sm transition-colors"
            >
              🎥 Video task
            </Link>
            <Link
              href="/promo"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 shadow-sm transition-colors"
            >
              📢 Repost &amp; earn
            </Link>
            <Link
              href="/guide"
              title="How everything works — in English and Amharic"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1.5 transition-colors"
            >
              📖 How it works
            </Link>
          </div>
          <p className="text-sm text-zinc-500 mt-0.5">{available.length.toLocaleString()} remaining</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {user.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={user.image} alt="" className="w-7 h-7 rounded-full" />
          )}
          <div className="text-right hidden sm:block">
            <div className="text-sm text-zinc-300 leading-tight">{user.name || user.email}</div>
            {user.name && <div className="text-xs text-zinc-500 leading-tight">{user.email}</div>}
          </div>
          <EditAccountLinks profile={profile} product={product} />
          <button
            onClick={async () => {
              await signOut()
              window.location.href = '/'
            }}
            className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Today's clicks, per platform (hidden when SHOW_CLICKED_TODAY is off) */}
      {showClickedToday && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Clicked today{todayTotal > 0 ? ` · ${todayTotal}` : ''}
          </span>
          {PLATFORMS.map((p) => (
            <span key={p.key} className="flex items-center gap-1.5 text-sm">
              <span className={`w-2 h-2 rounded-full ${p.dot}`} />
              <span className="text-zinc-400">{p.label}</span>
              <span className="tabular-nums font-medium text-zinc-200">{today[p.key] ?? 0}</span>
            </span>
          ))}
        </div>
      )}

      {/* Pending pay — approved and unapproved amounts shown independently */}
      {pendingPay && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-emerald-600/25 bg-emerald-600/5 px-3 py-2">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Pending pay ·{' '}
            <span className="text-emerald-300 font-semibold tabular-nums">
              {fmtBirr(pendingPay.total)} birr
            </span>
            {pendingPay.total <= 0 && (
              <span className="ml-1.5 text-emerald-400 normal-case">✓ all paid</span>
            )}
          </span>
          {pendingPay.total > 0 && (
            <>
              <span className="flex items-center gap-1.5 text-sm">
                <span className="text-zinc-400 normal-case">Approved</span>
                <span className="tabular-nums font-semibold text-emerald-400">
                  {fmtBirr(pendingPay.approvedBirr)} birr
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-sm">
                <span className="text-zinc-400 normal-case">Unapproved</span>
                <span className="tabular-nums font-semibold text-amber-400">
                  {fmtBirr(pendingPay.unapprovedBirr)} birr
                </span>
              </span>
            </>
          )}
          {([
            { label: 'Comments', t: pendingPay.comments },
            { label: 'Video', t: pendingPay.video },
            { label: 'Repost', t: pendingPay.promo },
          ] as const).map(({ label, t }) => (
            <span key={label} className="flex items-center gap-1.5 text-sm" title={`${t.count} unpaid`}>
              <span className="text-zinc-400">{label}</span>
              <span className="tabular-nums font-medium text-zinc-200">{fmtBirr(t.birr)}</span>
              <span className="text-[11px] text-zinc-600 tabular-nums">({t.count})</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )

  const messagesBlock =
    msgs.length > 0 ? (
      <div className="mb-4 space-y-2">
        {msgs.map((m) => (
          <MessageBanner key={m.id} m={m} onDismiss={() => dismissMsg(m.id)} />
        ))}
      </div>
    ) : null

  if (videos.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
        {header}
        {messagesBlock}
        <div className="text-center py-16">
          <p className="text-4xl mb-4">📭</p>
          <p className="text-lg font-medium text-zinc-300">No data yet</p>
          <p className="text-sm text-zinc-500 mt-2">
            Run <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-emerald-400">python upload.py</code> to push your CSV.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
      {header}
      {messagesBlock}

      {/* One-time payout confirmation — shown once after being marked paid */}
      {paidNotice != null && paidNotice > 0 && (
        <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3">
          <p className="text-sm text-emerald-200">
            🎉 You were paid{' '}
            <span className="font-bold">{fmtBirr(paidNotice)} birr</span>. Your pending balance has
            been reset — new earnings will start accruing again.
          </p>
        </div>
      )}

      {/* Hourly-limit notice */}
      {lockNotice && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
          <span className="text-lg leading-none">⏳</span>
          <p className="text-sm text-amber-200/90 flex-1">{lockNotice}</p>
          <button
            onClick={() => setLockNotice(null)}
            className="text-amber-200/70 hover:text-amber-100 text-sm shrink-0"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        {showClickedToday && (
          <input
            className="w-full sm:flex-1 sm:min-w-[180px] bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
            placeholder="Filter by URL, author or keyword…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        <div className="w-full sm:w-auto overflow-x-auto">
          <div className="flex w-max rounded-lg overflow-hidden border border-zinc-700">
            {PLATFORMS.map((p) => {
              const locked = isLocked(p.key)
              const reset = locked ? resetAtOf(p.key) : null
              return (
                <button
                  key={p.key}
                  title={locked ? 'Hourly limit reached — resets soon' : undefined}
                  className={`whitespace-nowrap px-3 py-2 text-sm transition-colors ${platform === p.key ? 'bg-teal-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'} ${locked ? 'opacity-60' : ''}`}
                  onClick={() => {
                    skipNextRotateRef.current = true
                    setPlatform(p.key)
                  }}
                >
                  {p.label}
                  {locked && reset ? (
                    <span className="ml-1.5 text-xs tabular-nums">🔒 {fmtDuration(reset - nowMs)}</span>
                  ) : (
                    <span className="ml-1.5 text-xs opacity-70 tabular-nums">
                      {availableByPlatform[p.key] ?? 0}
                    </span>
                  )}
                </button>
              )
            })}
            {COMING_SOON_PLATFORMS.map((p) => (
              <button
                key={p.label}
                disabled
                title="Coming soon"
                className="whitespace-nowrap px-3 py-2 text-sm bg-zinc-900 text-zinc-600 cursor-not-allowed opacity-60"
              >
                {p.label}
                <span className="ml-1.5 text-[10px] uppercase tracking-wide">soon</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Clustering controls (cluster count is set in lib/config.ts, not here).
          Only the "Cluster by" tabs hide with SHOW_CLICKED_TODAY; the caption and
          the Finish CTA always stay. */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        {showClickedToday && (
          <>
            <span className="text-xs text-zinc-500 uppercase tracking-wide">Cluster by</span>
            <div className="flex rounded-lg overflow-hidden border border-zinc-700 shrink-0">
              {clusterTabs.map(([g, label]) => (
                <button
                  key={g}
                  className={`px-3 py-1.5 text-sm transition-colors ${effGroupBy === g ? 'bg-teal-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'}`}
                  onClick={() => setGroupBy(g)}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
        <span className="text-xs text-zinc-600 tabular-nums">
          {effGroupBy === 'rank' ? RANK_CLUSTER_COUNT : DATE_CLUSTER_COUNT} clusters
          {supportsDate && (
            <span className="text-zinc-600">
              {' '}
              · {dateShare}% of workers on date, {100 - dateShare}% on rank
            </span>
          )}
        </span>
        {/* Get the app + Finish share one row: split on mobile, right-aligned on desktop */}
        <div className="flex gap-2 w-full sm:w-auto sm:ml-auto">
          {apk && (
            <a
              href={`${apk.url}?download=1`}
              title={`Download the Comment Helper Android app${apk.version ? ` (v${apk.version})` : ''}`}
              className="inline-flex flex-1 sm:flex-none items-center justify-center gap-1.5 whitespace-nowrap text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500 rounded-lg px-3 py-2 shadow-sm transition-colors"
            >
              🤖 Get the app
            </a>
          )}
          <FinishButton className="flex-1 sm:flex-none" />
        </div>
      </div>

      {available.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-4xl mb-4">✅</p>
          <p className="text-lg font-medium text-zinc-300">All done</p>
          <p className="text-sm text-zinc-500 mt-2">You&apos;ve opened every link assigned to you.</p>
        </div>
      ) : isLocked(platform) ? (
        (() => {
          const resets = PLATFORMS.map((p) => resetAtOf(p.key)).filter((x): x is number => x !== null)
          const soonest = resets.length ? Math.min(...resets) : nowMs
          const anyOtherWorkable = PLATFORMS.some((p) => p.key !== platform && isWorkable(p.key))
          return (
            <div className="text-center py-16">
              <p className="text-4xl mb-4">⏳</p>
              <p className="text-lg font-medium text-zinc-300">Hourly limit reached</p>
              <p className="text-sm text-zinc-500 mt-2">
                You&apos;ve opened {limitOf(platform)} {PLATFORMS.find((p) => p.key === platform)?.label} links within the limit window.
              </p>
              <p className="text-sm text-zinc-400 mt-3 tabular-nums">
                {PLATFORMS.find((p) => p.key === platform)?.label} unlocks in{' '}
                <span className="text-white">{fmtDuration((resetAtOf(platform) ?? nowMs) - nowMs)}</span>
              </p>
              <p className="text-xs text-zinc-600 mt-2">
                {anyOtherWorkable
                  ? 'Switching you to another platform…'
                  : `All platforms are at their limit. Next opens in ${fmtDuration(soonest - nowMs)}.`}
              </p>
            </div>
          )
        })()
      ) : clusters.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-lg font-medium text-zinc-300">No links here right now</p>
          <p className="text-sm text-zinc-500 mt-2">
            Nothing left under {PLATFORMS.find((p) => p.key === platform)?.label}. Try another platform tab.
          </p>
        </div>
      ) : (
        <ClusterList clusters={clusters} onOpen={onOpen} />
      )}

      {/* First-clicks reminder dialog */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-sm w-full p-5">
            <h3 className="text-base font-semibold text-white">Heads up</h3>
            <p className="text-sm text-zinc-400 mt-2">
              Once you open this link it will be <span className="text-emerald-400">removed from your list</span>,
              so you won&apos;t see it again. Comment on it now.
            </p>
            <p className="text-xs text-zinc-600 mt-2">
              Reminder {sessionClicks + 1} of {REMINDER_CLICKS} · shown for your first {REMINDER_CLICKS} links.
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setPending(null)}
                className="px-3 py-1.5 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const v = pending
                  setPending(null)
                  setSessionClicks((n) => n + 1)
                  proceed(v)
                }}
                className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
              >
                Open &amp; remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
