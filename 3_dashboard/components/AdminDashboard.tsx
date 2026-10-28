'use client'

import { useState, useRef, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/auth-client'
import {
  PRODUCTS,
  DEACTIVATED_PRODUCTS,
  VIDEO_PAYMENT_BIRR,
  COMMENT_PAY_RATE,
  PROMO_PAY_BIRR,
  ACCOUNT_PAY_BIRR,
  REFERRAL_PAY_RATE,
  REFERRAL_SHARE,
  CLICK_PLATFORM_LABELS,
  GENRES,
  GENRE_LABELS,
  DEFAULT_GENRE,
  genreOfProduct,
  productsInGenre,
} from '@/lib/config'
import type {
  AdminData,
  AdminUserRow,
  PendingPayments,
  ApkInfo,
  UserClick,
  GuideVideo,
  ReferralEarnings,
  PayAdjustment,
} from '@/lib/db'
import ApkAdmin from '@/components/ApkAdmin'
import GuideVideosAdmin from '@/components/GuideVideosAdmin'
import LlmModelPicker from '@/components/LlmModelPicker'
import BlockRules from '@/components/BlockRules'
import ScrollX from '@/components/ScrollX'
import PlatformLimits from '@/components/PlatformLimits'
import ActiveProducts from '@/components/ActiveProducts'
import GenreMix from '@/components/GenreMix'
import VerifySettings from '@/components/VerifySettings'
import { accountCreatedAt, accountAge, accountAgeWords } from '@/lib/tiktokId'

// Compare dotted version names numerically: returns >0 if a is newer than b
// (e.g. "1.10" > "1.9" > "1.1" > "1.0"). Non-numeric parts count as 0.
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i] ?? '0', 10) || 0
    const y = parseInt(pb[i] ?? '0', 10) || 0
    if (x !== y) return x - y
  }
  return 0
}

// Birr formatting: drop the trailing ".00", keep up to 2 decimals otherwise.
function fmtBirr(n: number): string {
  return n
    .toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

// A reversible admin action for the undo/redo stacks.
type AdminCmd = { label: string; undo: () => Promise<void>; redo: () => Promise<void> }

function post(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PLATFORMS: { key: string; label: string; dot: string }[] = [
  { key: 'tiktok', label: 'TikTok', dot: 'bg-pink-500' },
  { key: 'youtube_shorts', label: 'YT Shorts', dot: 'bg-orange-500' },
  { key: 'youtube_videos', label: 'YT Videos', dot: 'bg-red-500' },
  { key: 'instagram', label: 'Instagram', dot: 'bg-fuchsia-500' },
  { key: 'reddit', label: 'Reddit', dot: 'bg-amber-600' },
]

function fmtDateTime(iso: string) {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

// Group screenshots by their submission day (newest day first).
function groupByDay(
  shots: AdminUserRow['screenshots']
): [string, AdminUserRow['screenshots']][] {
  const m = new Map<string, AdminUserRow['screenshots']>()
  for (const s of shots) {
    const day = (s.uploaded_at || '').slice(0, 10) || 'unknown'
    const arr = m.get(day)
    if (arr) arr.push(s)
    else m.set(day, [s])
  }
  return Array.from(m.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1))
}

/** One user's result from an admin comment-presence sweep. */
interface SweepRow {
  userId: string
  username: string
  day: string
  checked: number
  found: number
  skipped: number
  pct: number | null
  /** Links of that day still unjudged; > 0 means this user is mid-read. */
  remaining: number
  /** Present when the sweep auto-blocked them, with the sample and rule it acted on. */
  blocked?: { judged: number; rule?: string; pct?: number | null }
}

/** One judged link in the per-user presence breakdown. */
interface PresenceLink {
  url: string
  day: string
  found: boolean
  judgeable: boolean
  text: string | null
  comments: number | null
  hearts: number | null
  views: number | null
  isPhoto: boolean | null
  checkedAt: string
  clickedAt: string | null
  assigned: string | null
  title: string | null
}

interface PresenceDetail {
  userId: string
  name: string
  username: string | null
  days: number
  totals: { links: number; judged: number; found: number; missing: number; skipped: number }
  timing: {
    gaps: number
    breaks: number
    maxGapSec: number
    truncated: boolean
    avgGapSec: number | null
    medGapSec: number | null
  }
  history: PresenceDayShape[]
  links: PresenceLink[]
}

/** One day of comment-presence, as stored per user. */
interface PresenceDayShape {
  day: string
  checked: number
  found: number
  skipped: number
  pct: number | null
}

/**
 * Badge colour by score. The thresholds are deliberately forgiving at the top —
 * TikTok hides some comments and paging cuts others off, so a genuine worker
 * rarely scores 100%.
 */
/** Clock time of a click, in the admin's own timezone. Seconds included: the
 *  gap between two links is the whole point, and minutes alone hide it. */
function clockTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** 95 -> 1m 35s. Raw seconds stop being readable somewhere around a minute. */
function duration(sec: number | null): string {
  if (sec === null) return '—'
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`
  const m = Math.floor(sec / 60)
  const r = Math.round(sec - m * 60)
  return r === 0 ? `${m}m` : `${m}m ${r}s`
}

/**
 * Presence percentage over the recent days, as a plain inline SVG.
 *
 * No chart library: it is one polyline and a few dots, and the point is to see
 * whether a user is drifting down or holding steady. Days with nothing
 * judgeable have no percentage and are drawn as GAPS, not as zero — a scraping
 * failure must not look like a collapse.
 */
function PresenceTrend({
  history,
  links = [],
  truncated = false,
}: {
  history: PresenceDayShape[]
  /** Every judged link, so a hovered day can report what it is actually made of. */
  links?: PresenceLink[]
  /** The link reader hit its cap, so the OLDEST day in `links` is only partly
   *  present. Its link-derived counts would be wrong and are left out — the
   *  same call the gap timing makes for the same reason. */
  truncated?: boolean
}) {
  const [hover, setHover] = useState<number | null>(null)
  const pts = history.filter((d) => d.pct !== null)

  // What each day is made of, from the links themselves. The stored day row has
  // only the three totals; the links carry when the user worked and when the day
  // was last read, which is what a dot is actually worth explaining.
  const perDay = useMemo(() => {
    const out = new Map<
      string,
      { opened: number; found: number; missing: number; skipped: number; first: number | null; last: number | null; checked: number | null }
    >()
    for (const l of links) {
      const g =
        out.get(l.day) ??
        { opened: 0, found: 0, missing: 0, skipped: 0, first: null, last: null, checked: null }
      g.opened++
      if (!l.judgeable) g.skipped++
      else if (l.found) g.found++
      else g.missing++
      const clicked = l.clickedAt ? Date.parse(l.clickedAt) : NaN
      if (!Number.isNaN(clicked)) {
        if (g.first === null || clicked < g.first) g.first = clicked
        if (g.last === null || clicked > g.last) g.last = clicked
      }
      const seen = Date.parse(l.checkedAt)
      if (!Number.isNaN(seen) && (g.checked === null || seen > g.checked)) g.checked = seen
      out.set(l.day, g)
    }
    // The cap lands mid-day, so the oldest day in view is missing an unknown
    // share of its links. Reporting "18 links opened" for a day that really had
    // 160 would be worse than saying nothing.
    if (truncated && links.length > 0) {
      const oldest = links.reduce((a, l) => (l.day < a ? l.day : a), links[0].day)
      out.delete(oldest)
    }
    return out
  }, [links, truncated])

  if (pts.length < 2) return null

  const W = 560
  const H = 90
  const PAD = 6
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, history.length - 1)
  const y = (pct: number) => H - PAD - (pct / 100) * (H - PAD * 2)

  // Broken into runs, so a gap day splits the line instead of bridging it.
  const runs: { i: number; pct: number }[][] = []
  let run: { i: number; pct: number }[] = []
  history.forEach((d, i) => {
    if (d.pct === null) {
      if (run.length > 0) runs.push(run)
      run = []
    } else run.push({ i, pct: d.pct })
  })
  if (run.length > 0) runs.push(run)

  const last = pts[pts.length - 1].pct as number
  const avg = Math.round(pts.reduce((a, d) => a + (d.pct as number), 0) / pts.length)

  return (
    <div className="px-4 py-3 border-b border-zinc-800">
      <div className="flex items-baseline justify-between text-[11px] text-zinc-500 mb-1">
        <span>presence by day</span>
        <span>
          latest <span className="text-zinc-300">{last}%</span> · mean of days{' '}
          <span className="text-zinc-300">{avg}%</span>
        </span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[90px]" preserveAspectRatio="none">
          {[0, 50, 100].map((g) => (
            <g key={g}>
              <line x1={PAD} x2={W - PAD} y1={y(g)} y2={y(g)} stroke="#3f3f46" strokeWidth={0.5} strokeDasharray="3 3" />
            </g>
          ))}
          {runs.map((r, k) => (
            <polyline
              key={k}
              fill="none"
              stroke="#34d399"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              points={r.map((d) => `${x(d.i)},${y(d.pct)}`).join(' ')}
            />
          ))}
          {hover !== null && history[hover]?.pct !== null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD}
              y2={H - PAD}
              stroke="#52525b"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {history.map((d, i) =>
            d.pct === null ? null : (
              <circle
                key={d.day}
                cx={x(i)}
                cy={y(d.pct)}
                r={hover === i ? 4 : 2.5}
                fill={hover === i ? '#a7f3d0' : '#34d399'}
              />
            )
          )}
          {/* Invisible hit strips, one per day, spanning the full height. The
              dots are 2.5px on a chart that is stretched horizontally, so
              aiming at them is fiddly; a column is easy to hit and means the
              tooltip follows the mouse across the whole graph. */}
          {history.map((d, i) =>
            d.pct === null ? null : (
              <rect
                key={`hit-${d.day}`}
                x={x(i) - (W - PAD * 2) / Math.max(1, history.length - 1) / 2}
                y={0}
                width={(W - PAD * 2) / Math.max(1, history.length - 1)}
                height={H}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              />
            )
          )}
        </svg>

        {hover !== null && history[hover]?.pct !== null && (() => {
          const d = history[hover]
          const extra = perDay.get(d.day)
          const prev = history.slice(0, hover).reverse().find((p) => p.pct !== null)
          const delta = prev?.pct != null && d.pct != null ? d.pct - prev.pct : null
          // Pinned left or right of centre so it never runs off the modal.
          const rightHalf = hover > history.length / 2
          return (
            <div
              className={`absolute top-0 z-10 pointer-events-none rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-[11px] shadow-xl ${
                rightHalf ? 'left-2' : 'right-2'
              }`}
            >
              <div className="text-zinc-200 font-medium">
                {new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                })}
                <span className="text-zinc-500 font-normal"> · {d.day}</span>
              </div>
              <div className="mt-1 text-zinc-300">
                <span className="text-emerald-300 text-sm font-semibold">{d.pct}%</span>
                <span className="text-zinc-500"> presence</span>
                {delta !== null && (
                  <span className={delta >= 0 ? ' text-emerald-400' : ' text-rose-400'}>
                    {' '}
                    {delta >= 0 ? '+' : ''}
                    {delta} vs previous day
                  </span>
                )}
              </div>
              <table className="mt-1.5 text-zinc-400">
                <tbody>
                  <tr>
                    <td className="pr-3">found</td>
                    <td className="text-zinc-200">{d.found}</td>
                  </tr>
                  <tr>
                    <td className="pr-3">missing</td>
                    <td className="text-zinc-200">{Math.max(0, d.checked - d.found)}</td>
                  </tr>
                  <tr>
                    <td className="pr-3">judged</td>
                    <td className="text-zinc-200">{d.checked}</td>
                  </tr>
                  <tr>
                    {/* Unreadable links are excluded from the percentage rather
                        than counted against the user, so they are worth naming. */}
                    <td className="pr-3">skipped</td>
                    <td className="text-zinc-200">
                      {d.skipped}
                      {d.skipped > 0 && (
                        <span className="text-zinc-600"> (not counted)</span>
                      )}
                    </td>
                  </tr>
                  {extra && (
                    <tr>
                      <td className="pr-3">links opened</td>
                      <td className="text-zinc-200">{extra.opened}</td>
                    </tr>
                  )}
                  {extra?.first != null && extra?.last != null && (
                    <tr>
                      <td className="pr-3">worked</td>
                      <td className="text-zinc-200">
                        {new Date(extra.first).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                        {' – '}
                        {new Date(extra.last).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                    </tr>
                  )}
                  {extra?.checked != null && (
                    <tr>
                      <td className="pr-3">last checked</td>
                      <td className="text-zinc-200">
                        {new Date(extra.checked).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )
        })()}
      </div>
      <div className="flex justify-between text-[10px] text-zinc-600">
        <span>{history[0]?.day}</span>
        <span>{history[history.length - 1]?.day}</span>
      </div>
    </div>
  )
}

/** 12400 -> 12.4k. Long counts wreck a narrow column and nobody reads the digits. */
function compact(n: number | null): string {
  if (n === null) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  return (n / 1_000_000).toFixed(1) + 'M'
}

function presenceTone(pct: number): string {
  if (pct >= 80) return 'text-emerald-200 bg-emerald-600/20 border-emerald-500/40'
  if (pct >= 50) return 'text-amber-200 bg-amber-600/20 border-amber-500/40'
  return 'text-rose-200 bg-rose-600/20 border-rose-500/40'
}

/**
 * A global task switch: what it is, what it means right now, and a toggle.
 *
 * The video and repost panels were the same twenty lines of markup twice over,
 * differing only in wording — so a change to one silently left the other alone.
 */
function TaskToggle({
  title,
  on,
  onLabel,
  offLabel,
  onToggle,
}: {
  title: string
  on: boolean
  onLabel: string
  offLabel: string
  onToggle: (next: boolean) => void
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="text-sm font-semibold text-white">{title}</div>
        <div className="text-xs text-zinc-500">{on ? onLabel : offLabel}</div>
      </div>
      <button
        onClick={() => onToggle(!on)}
        role="switch"
        aria-checked={on}
        aria-label={title}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          on ? 'bg-emerald-600' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
            on ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}

export default function AdminDashboard({
  data,
  adminEmail,
  pendingByUser,
  referralByUser,
  apk,
  guideVideos,
  minAgeDays,
  payAdjustments,
  autoBlockCounts,
  appVersions,
  videoTaskEnabled,
  promoTaskEnabled,
  presence,
  presenceHistory,
  tiktokAccounts,
  genre,
  genrePauses,
}: {
  /**
   * Genres each worker is no longer served, paused by the comment check's genre
   * rule (their comments missing on that genre while another genre's are fine).
   */
  genrePauses: Record<string, { genre: string; pct: number; judged: number; found: number; pausedAt: string }[]>
  /**
   * The admin's master genre. The server has already cut every click in
   * `data` to this genre's products, so most of this page is about it with no
   * further work; this prop is for the parts that have to NAME it, and for the
   * product lists that must not offer another genre's products.
   */
  genre: string
  data: AdminData
  adminEmail: string
  pendingByUser: Record<string, PendingPayments>
  /** Per referrer: who they brought in and what they are owed for it. Keyed by
   *  the REFERRER's user id, so a user with no entry has referred nobody. */
  referralByUser: Record<string, ReferralEarnings>
  apk: ApkInfo | null
  guideVideos: GuideVideo[]
  /** The admin-set minimum TikTok account age, for flagging new accounts. */
  minAgeDays: number
  /** Every pending-pay edit, per user, newest first. */
  payAdjustments: Record<string, PayAdjustment[]>
  /** Automatic blocks per user, counted since 2026-10-20 (3 allowed, then forever). */
  autoBlockCounts: Record<string, number>
  appVersions: Record<string, { name: string | null; code: number | null }>
  videoTaskEnabled: boolean
  promoTaskEnabled: boolean
  /** Badge value per user: the mean of their daily comment-presence scores. */
  presence: Record<string, { pct: number; days: number }>
  /** Last 7 days per user, newest first, for the expanded view. */
  presenceHistory: Record<string, PresenceDayShape[]>
  /** Numeric TikTok id per user, learned from their own comments. It encodes
   *  the account's creation date — see lib/tiktokId. */
  // The source travels with the id: a registration check watched the account
  // comment, a presence scan merely happened to see it. See getTiktokAccounts.
  tiktokAccounts: Record<string, { handle: string; uid: string; source?: 'verified' | 'seen' }>
}) {
  const router = useRouter()
  const [resetting, setResetting] = useState(false)
  const [payingUser, setPayingUser] = useState<string | null>(null)

  // ── Undo / redo (session-only). Each action pushes a reversible command. ────
  const [undoStack, setUndoStack] = useState<AdminCmd[]>([])
  const [redoStack, setRedoStack] = useState<AdminCmd[]>([])
  const [histBusy, setHistBusy] = useState(false)

  function pushCmd(cmd: AdminCmd) {
    setUndoStack((s) => [...s, cmd])
    setRedoStack([]) // a new action invalidates the redo branch
  }
  async function runUndo() {
    const cmd = undoStack[undoStack.length - 1]
    if (!cmd || histBusy) return
    setHistBusy(true)
    try {
      await cmd.undo()
      setUndoStack((s) => s.slice(0, -1))
      setRedoStack((r) => [...r, cmd])
      router.refresh()
    } finally {
      setHistBusy(false)
    }
  }
  async function runRedo() {
    const cmd = redoStack[redoStack.length - 1]
    if (!cmd || histBusy) return
    setHistBusy(true)
    try {
      await cmd.redo()
      setRedoStack((r) => r.slice(0, -1))
      setUndoStack((s) => [...s, cmd])
      router.refresh()
    } finally {
      setHistBusy(false)
    }
  }

  async function approvePay(userId: string) {
    setPayingUser(userId)
    try {
      await post('/api/admin/pay', { userId, action: 'approve' })
      router.refresh()
      pushCmd({
        label: 'approve pay',
        undo: () => post('/api/admin/pay', { userId, action: 'unapprove' }).then(() => {}),
        redo: () => post('/api/admin/pay', { userId, action: 'approve' }).then(() => {}),
      })
    } finally {
      setPayingUser(null)
    }
  }

  async function markPaidPay(userId: string) {
    setPayingUser(userId)
    try {
      // Snapshot the user's current state (kept by day) before the payment reset.
      const u = data.users.find((x) => x.id === userId)
      const snapshot = u
        ? { ...u, pendingTotal: pendingByUser[userId]?.total ?? 0, snapshotAt: new Date().toISOString() }
        : undefined
      const res = await post('/api/admin/pay', { userId, action: 'paid', snapshot })
      const d = await res.json().catch(() => ({}))
      router.refresh()
      // Descriptor is refreshed on redo so a later undo reverses the new payout.
      const holder = { undo: d.undo }
      pushCmd({
        label: `mark paid ${d.amount ?? ''}`,
        undo: () => post('/api/admin/pay', { userId, action: 'undo-paid', undo: holder.undo }).then(() => {}),
        redo: async () => {
          const r = await post('/api/admin/pay', { userId, action: 'paid' })
          const dd = await r.json().catch(() => ({}))
          holder.undo = dd.undo
        },
      })
    } finally {
      setPayingUser(null)
    }
  }

  // null = closed, 'all' = reset everyone, or a userId = reset that one user.
  const [resetTarget, setResetTarget] = useState<'all' | string | null>(null)
  // The user pending permanent deletion (null = closed).
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  // The user whose screenshots are shown in the modal (null = closed).
  const [shotUser, setShotUser] = useState<AdminUserRow | null>(null)
  // The user whose clicked links are shown (null = closed), plus the fetched list.
  const [clicksUser, setClicksUser] = useState<AdminUserRow | null>(null)
  const [clicksList, setClicksList] = useState<UserClick[] | null>(null)

  async function openClicks(u: AdminUserRow) {
    setClicksUser(u)
    setClicksList(null) // show loading state
    try {
      const res = await fetch(`/api/admin/user-clicks?userId=${encodeURIComponent(u.id)}`)
      const d = await res.json().catch(() => ({}))
      setClicksList(res.ok && Array.isArray(d.clicks) ? d.clicks : [])
    } catch {
      setClicksList([])
    }
  }

  // Past-state snapshots (saved when marking a user paid, before the reset).
  const [snapUser, setSnapUser] = useState<AdminUserRow | null>(null)
  const [snapList, setSnapList] = useState<{ id: number; day: string; created_at: string }[] | null>(null)
  const [snapView, setSnapView] = useState<{ day: string; created_at: string; snapshot: Record<string, unknown> } | null>(null)
  async function openSnapshots(u: AdminUserRow) {
    setSnapUser(u); setSnapList(null); setSnapView(null)
    try {
      const res = await fetch(`/api/admin/user-snapshots?userId=${encodeURIComponent(u.id)}`)
      const d = await res.json().catch(() => ({}))
      setSnapList(res.ok && Array.isArray(d.snapshots) ? d.snapshots : [])
    } catch { setSnapList([]) }
  }
  async function viewSnapshot(id: number) {
    setSnapView(null)
    try {
      const res = await fetch(`/api/admin/user-snapshots?id=${id}`)
      const d = await res.json().catch(() => ({}))
      if (res.ok) setSnapView(d)
    } catch { /* ignore */ }
  }

  // Verify that this user's @username is among the commenters on the last 300
  // links they OPENED. Reads TikTok's comment list over plain HTTP — no browser
  // and no captcha, so it works on the deployed dashboard too.
  //
  // Three hundred is chosen to feed the rate rule's 200-JUDGED denominator rather
  // than for its own sake: about 15% of reads cannot be judged, so 300 read is
  // roughly 255 judged. See RECENT_SAMPLE in lib/commentPresence.
  const [verifyingUser, setVerifyingUser] = useState<string | null>(null)
  /** One judged link from the presence ledger. */
  interface JudgedLinkShape {
    url: string
    found: boolean
    judgeable: boolean
    /** Which day it was opened. The sample spans days, so the row says which. */
    day?: string
    /** The comment that was found, as it was read off the video. */
    text?: string | null
  }
  /** One distinct comment found, and how many links carried it. */
  interface FoundCommentShape {
    text: string
    count: number
    days: number
    firstDay: string
    lastDay: string
  }
  /** A finished single-user check. */
  interface VerifyReportShape {
    who: string
    username: string
    checked: number
    found: number
    skipped: number
    pct: number | null
    /** Links in the sample — 100, or everything they have opened if fewer. */
    total: number
    /** The oldest and newest day the sample reaches back over. */
    from: string
    to: string
    days: number
    links: JudgedLinkShape[]
    /** The distinct comments found, most-used first. */
    comments: FoundCommentShape[]
    /** How many judged links the block rule needs. */
    blockSample: number
    /** Set when this check blocked them. */
    blocked?: {
      judged: number
      skipped: number
      /** 'empty' — nothing on 50; 'ratio' — under 10% of 200. */
      rule?: string
      pct?: number | null
    }
    /** The rate rule's size and threshold, so the panel can name them. */
    ratioSample: number
    ratioMinPct: number
    /** False when auto-blocking is switched off in the settings. */
    autoBlockOn: boolean
    /**
     * What the RATE RULE read, which is not what the header shows.
     *
     * The header is this check's own tally; the rule reads a fixed window of the
     * newest judged links. When they differ, the rule's number is the one that
     * decided, so it belongs on screen beside the other.
     */
    ruleRate: { judged: number; found: number; pct: number } | null
    /** The genre rule's reading: each genre's rate, and what it paused or lifted. */
    genres: {
      rates: { genre: string; judged: number; found: number; pct: number; scored: boolean; below: boolean }[]
      paused: string[]
      lifted: string[]
      anyPassing: boolean
    } | null
    genreMinPct: number
    genreSample: number
    /** Why it did not, when it did not. Empty while the check is unfinished. */
    blockNote: string
  }
  // Live progress for the per-user verification loop (null = idle).
  const [verifyProgress, setVerifyProgress] = useState<
    { who: string; done: number; total: number; note: string } | null
  >(null)
  // Verify all: the decision on each user as it is made, newest first, so the
  // outcome is visible while the run goes on rather than in a summary at the end.
  const [verifyLog, setVerifyLog] = useState<{ who: string; text: string; blocked: boolean }[]>([])
  // The finished run, shown as a modal (null = closed).
  const [verifyReport, setVerifyReport] = useState<VerifyReportShape | null>(null)
  const stopVerify = useRef(false)
  const verifyAbort = useRef<AbortController | null>(null)

  function stopVerifyNow() {
    stopVerify.current = true
    verifyAbort.current?.abort()
  }
  const [verifyingAll, setVerifyingAll] = useState(false)
  // Idle workers are out of the list by default — see isIdle. One click brings
  // them back, because "where did that person go" must have an answer on screen.
  const [showIdle, setShowIdle] = useState(false)
  /** Which question the list is ordered to answer — see sortedUsers. */
  const [userSort, setUserSort] = useState<'clicks' | 'pending' | 'comments' | 'name' | 'referrals'>('clicks')
  const [deductingUser, setDeductingUser] = useState<string | null>(null)
  const [blockingUser, setBlockingUser] = useState<string | null>(null)

  // Block a user with a reason. 'bank' / 'tiktok' let the user self-unblock by
  // entering a new bank account / TikTok link on next sign-in; 'forever' is a
  // hard block. Confirm first (it signs them out).
  async function blockUserWith(u: AdminUserRow, reason: 'bank' | 'tiktok' | 'forever') {
    const label = u.profile?.name || u.name || u.email
    const reasonText = {
      bank: 'Incorrect bank account — they must enter a new bank account number to sign in again.',
      tiktok: 'Visibility restricted TikTok account — they must enter a new TikTok profile link to sign in again.',
      forever: 'Block forever — they will not be able to sign in by any means.',
    }[reason]
    if (!confirm(`Block ${label}?\n\n${reasonText}\n\nThey'll be signed out immediately.`)) return
    setBlockingUser(u.id)
    try {
      const res = await fetch('/api/admin/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.id, action: 'block', reason }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d?.error || 'Could not block this user.')
        return
      }
      router.refresh()
    } finally {
      setBlockingUser(null)
    }
  }

  async function unblockUserAction(u: AdminUserRow) {
    const label = u.profile?.name || u.name || u.email
    // WHAT UNBLOCKING NOW MEANS. It used to make the person permanently immune
    // to the automatic check; it now re-arms it, so this dialog has to say so —
    // pressing it on somebody whose comments still cannot be found buys them
    // until the next sweep and no longer.
    if (!confirm(
      `Unblock ${label}?\n\n` +
      "They'll be able to sign in and register again.\n\n" +
      'This also RE-ARMS the automatic comment check on them: if their comment still ' +
      'cannot be found on their recent links, the next nightly sweep — or the next ' +
      'verify you run — will block them again. Unblocking used to make somebody ' +
      'immune to it for good.'
    )) return
    setBlockingUser(u.id)
    try {
      const res = await fetch('/api/admin/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.id, action: 'unblock' }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d?.error || 'Could not unblock this user.')
        return
      }
      router.refresh()
    } finally {
      setBlockingUser(null)
    }
  }

  // Remove all of an (unverified) user's clicks — each clicked link regains one
  // click of quota, so their unverified engagement stops retiring links.
  async function deductUserClicks(u: AdminUserRow) {
    if (!confirm(`Remove ALL of ${u.profile?.name || u.email}'s clicks?\n\nEach link they clicked regains one click of quota. Use this for unverified users whose clicks shouldn't count.`)) return
    setDeductingUser(u.id)
    try {
      const res = await fetch('/api/admin/user-clicks', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not remove clicks.'); return }
      alert(`Removed ${d.removed ?? 0} click(s) — those links each regained one click of quota.`)
      router.refresh()
    } finally {
      setDeductingUser(null)
    }
  }

  /**
   * The per-user check, run over everybody who worked this week.
   *
   * IT USED TO BE A DIFFERENT CHECK ENTIRELY: it matched each @username against
   * comments_extracted.json, a file sitting in 2_comment_automation — which does
   * not exist on the deployed dashboard at all, so the button could only fail
   * there. And even where the file existed, "your handle appears somewhere in a
   * corpus" is not the question the single-user button answers, so the two
   * buttons disagreed by construction.
   *
   * Now it is the same call, in a loop: same endpoint, same 300 links, same two
   * block rules, same freshness cutoff. One implementation, so a sweep cannot
   * reach a verdict the report in front of you would not.
   *
   * WHO: everyone with a TikTok link who did any work in the last seven days.
   * Somebody who stopped a fortnight ago is not evidence about this week, and
   * reading their links is minutes that the people still working need.
   *
   * It is slow and it says so: 300 videos a person at 1-5 seconds each. Stoppable
   * at any point, and everything judged before you stop is in the ledger.
   */
  async function verifyAll() {
    const week = Date.now() - 7 * 86400000
    const targets = data.users.filter((u) => {
      // Blocked users are skipped: the check exists to decide whether to
      // block someone, and they are already blocked.
      if (u.blocked) return false
      if (!u.profile?.tiktok_url) return false
      const last = u.lastWorkAt ? Date.parse(u.lastWorkAt) : NaN
      return Number.isFinite(last) && last >= week
    })
    if (targets.length === 0) {
      alert('Nobody unblocked with a TikTok link has done any work in the last 7 days.')
      return
    }
    if (!confirm(
      `Check all ${targets.length} unblocked user(s) who worked in the last 7 days?\n\n` +
      'Each one gets exactly the check the single 🔍 Verify button runs: their last ' +
      '300 links read again now, and the two auto-block rules applied. Anyone who ' +
      'fails them is blocked automatically — you can unblock from their row.\n\n' +
      'This is 300 videos per person at a few seconds each, so it takes a while. ' +
      'Stop whenever you like; everything judged before you stop is saved.'
    )) return

    stopVerify.current = false
    setVerifyLog([])
    setVerifyingAll(true)
    const blocked: string[] = []
    const failedOn: string[] = []
    let done = 0
    try {
      for (const u of targets) {
        if (stopVerify.current) break
        const who = u.profile?.name || u.name || u.email || 'user'
        done++
        setVerifyProgress({ who: `${who} (${done}/${targets.length})`, done: 0, total: 0, note: 'Starting…' })
        const { report, failed } = await runVerify(u, (d2, t2, note) =>
          setVerifyProgress({ who: `${who} (${done}/${targets.length})`, done: d2, total: t2, note })
        )
        if (failed) failedOn.push(`${who}: ${failed}`)
        // DECIDED NOW, NOT AT THE END. The server applies the auto-block rules
        // the moment this user's check finishes — exactly as the single Verify
        // button does — so the decision is shown and the table refreshed here,
        // before the next user starts.
        const why = report?.blocked
          ? report.blocked.rule === 'ratio'
            ? `${report.blocked.pct ?? 0}% of ${report.blocked.judged} judged`
            : report.blocked.rule === 'genres'
              ? `under ${report.genreMinPct}% in every genre (${report.blocked.pct ?? 0}% of ${report.blocked.judged})`
              : `nothing on ${report.blocked.judged} judged`
          : ''
        // Genres paused rather than a block: said in the log, since it changes
        // what this person is served from now on.
        const pausedNow = report?.genres?.paused ?? []
        if (report?.blocked) blocked.push(`${who} — ${why}`)
        const text = failed
          ? `not finished: ${failed}`
          : report?.blocked
            ? `🚫 blocked · ${why}`
            : report
              ? `✓ kept · ${report.found}/${report.checked} carry their comment${report.pct !== null ? ` (${report.pct}%)` : ''}` +
                (pausedNow.length ? ` · ⏸ paused: ${pausedNow.map((g) => GENRE_LABELS[g] ?? g).join(', ')}` : '')
              : 'stopped'
        setVerifyLog((prev) => [{ who, text, blocked: !!report?.blocked }, ...prev].slice(0, 50))
        router.refresh()
      }
      router.refresh()
      alert(
        [
          stopVerify.current
            ? `Stopped after ${done} of ${targets.length} user(s).`
            : `Checked ${done} user(s).`,
          blocked.length
            ? `\nBlocked ${blocked.length}:\n` + blocked.join('\n')
            : '\nNobody was blocked.',
          failedOn.length ? `\nCould not finish:\n` + failedOn.join('\n') : '',
        ].join('\n')
      )
    } catch (e) {
      alert(`Verify-all error: ${String((e as Error)?.message || e)}`)
    } finally {
      setVerifyingAll(false)
      setVerifyProgress(null)
    }
  }
  // ── Comment-presence sweep ─────────────────────────────────────────────────
  // Scores every user active in the last 7 days against the links they opened on
  // their OWN last active day. Batched one user per request so the bar moves —
  // scoring one user means reading six videos' comments, ~10-25s.
  const [sweeping, setSweeping] = useState(false)
  const [sweepDone, setSweepDone] = useState(0)
  const [sweepTotal, setSweepTotal] = useState(0)
  const [sweepNote, setSweepNote] = useState('')
  const [sweepReport, setSweepReport] = useState<SweepRow[] | null>(null)
  // The threshold the finished report was produced under, so a block can be
  // read against the rule that made it rather than against today's setting.
  const [sweepSample, setSweepSample] = useState(50)
  // The per-user breakdown behind a name in the presence report.
  const [detail, setDetail] = useState<PresenceDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState<string | null>(null)
  const [detailErr, setDetailErr] = useState('')
  // Groq's read on why some comments never appeared.
  const [analysis, setAnalysis] = useState<{ text: string; model: string; over: number } | null>(null)
  const [analysing, setAnalysing] = useState(false)

  async function analysePresence(userId: string, days: number) {
    setAnalysing(true)
    setAnalysis(null)
    setDetailErr('')
    try {
      const res = await fetch('/api/admin/comment-presence/analyse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, days }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setDetailErr(d?.error || 'Analysis failed.'); return }
      setAnalysis({
        text: String(d.analysis || ''),
        model: String(d.model || ''),
        over: Number(d?.sampled?.aggregatedOver) || 0,
      })
    } catch {
      setDetailErr('Network error.')
    } finally {
      setAnalysing(false)
    }
  }

  async function openPresenceDetail(userId: string) {
    setDetailLoading(userId)
    setDetailErr('')
    try {
      const res = await fetch(`/api/admin/comment-presence/user?userId=${encodeURIComponent(userId)}&days=7`)
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setDetailErr(d?.error || 'Could not load the breakdown.'); return }
      setAnalysis(null)
      setDetail(d as PresenceDetail)
    } catch {
      setDetailErr('Network error.')
    } finally {
      setDetailLoading(null)
    }
  }
  const stopSweep = useRef(false)
  // The request currently in flight. Stop has to ABORT it, not just set a flag:
  // a batch runs for up to 45 seconds, so a flag checked between requests leaves
  // the button looking dead for most of a minute.
  const sweepAbort = useRef<AbortController | null>(null)
  // Judged links a user must have with NO comment of theirs on any of them
  // before the sweep blocks them. Held as a string so the field can be empty
  // while being typed; the server clamps whatever arrives.
  const [blockSample, setBlockSample] = useState('50')

  function stopSweepNow() {
    stopSweep.current = true
    setSweepNote('Stopping…')
    sweepAbort.current?.abort()
  }

  async function runPresenceSweep() {
    if (sweeping) { stopSweepNow(); return }
    // Clamped here as well as on the server, so the dialog states the number
    // that will actually be used rather than whatever happens to be typed.
    const sample = Math.max(20, Math.min(80, Math.round(Number(blockSample) || 50)))
    if (String(sample) !== blockSample.trim()) setBlockSample(String(sample))
    if (!confirm(
      'Check comment presence for every user active in the last 7 days?\n\n' +
      'Each user is scored against the links they opened on their own last active day, ' +
      'and every link is read again NOW rather than reusing an earlier result. ' +
      'Reading one video takes a few seconds, so this runs for a while — progress is ' +
      'saved as it goes and you can stop any time, but starting again re-reads the links.\n\n' +
      `Anyone with ${sample} readable links and NOT ONE comment of their own on any of ` +
      'them will be blocked automatically. Unreadable links do not count toward that, ' +
      'and a single comment found anywhere stops it. You can unblock from this page.'
    )) return

    stopSweep.current = false
    setSweeping(true)
    setSweepNote('Starting…')
    const rows: SweepRow[] = []
    let offset = 0
    // The freshness cutoff for THIS sweep: the server mints it on the first
    // request and it is echoed on every one after. Links judged before it are
    // read again, so the report is what the videos say now. Echoing matters —
    // without it each request would open its own pass, re-judge the same user's
    // links forever and never reach the next user.
    let since = ''
    try {
      const head = await fetch('/api/admin/comment-presence')
      const info = await head.json().catch(() => ({}))
      if (!head.ok) { alert(info?.error || 'Could not start.'); return }
      setSweepTotal(Number(info.total) || 0)
      setSweepDone(0)

      for (;;) {
        if (stopSweep.current) { setSweepNote('Stopped — scores so far are saved.'); break }
        const ctl = new AbortController()
        sweepAbort.current = ctl
        let res: Response
        try {
          res = await fetch('/api/admin/comment-presence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              since ? { offset, since, blockSample: sample } : { offset, blockSample: sample }
            ),
            signal: ctl.signal,
          })
        } catch {
          // Aborted by Stop, or the connection dropped. Either way the ledger
          // holds every link judged before this batch, so resuming re-reads at
          // most this one batch.
          setSweepNote(
            stopSweep.current
              ? 'Stopped — scores so far are saved.'
              : 'Connection lost — scores so far are saved.'
          )
          break
        } finally {
          sweepAbort.current = null
        }
        if (stopSweep.current) { setSweepNote('Stopped — scores so far are saved.'); break }
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setSweepNote(d?.error || 'Sweep failed.'); break }
        // A user with 160 links takes several requests, so the SAME offset can
        // come back repeatedly while they are still being read. Progress is
        // therefore "did anything get judged", not "did the offset move".
        const batch = Array.isArray(d.results) ? (d.results as SweepRow[]) : []
        for (const r of batch) {
          // Later rows for a user supersede earlier partial ones.
          const at = rows.findIndex((x) => x.userId === r.userId && x.day === r.day)
          if (at >= 0) rows[at] = r
          else rows.push(r)
        }
        if (typeof d.since === 'string' && d.since) since = d.since
        if (Number(d.blockSample) > 0) setSweepSample(Number(d.blockSample))
        const next = Number(d.nextOffset)
        const moved = Number.isFinite(next) && next > offset
        if (!moved && batch.length === 0) { setSweepNote('Sweep stalled.'); break }
        if (moved) offset = next
        setSweepDone(offset)
        setSweepTotal(Number(d.total) || 0)
        const busy = batch.find((r) => r.remaining > 0)
        setSweepNote(
          busy
            ? `@${busy.username}: ${busy.remaining} link(s) left — ${rows.length} user(s) so far`
            : `${rows.length} user(s) scored`
        )
        if (d.done) { setSweepNote('Done.'); break }
      }
      if (rows.length > 0) setSweepReport(rows)
      // Pull the fresh badges in — the server component recomputes the averages.
      router.refresh()
    } finally {
      setSweeping(false)
      stopSweep.current = false
    }
  }

  /**
   * Run the per-user check to the end, resuming until nothing is left.
   *
   * THE ONE IMPLEMENTATION. Both the single button and "Verify all" call this,
   * so a sweep cannot judge somebody differently from the way the report they are
   * looking at judged them — same endpoint, same 300 links, same rules, same
   * freshness cutoff.
   *
   * Returns the last report, or an error string. Never throws: a sweep must not
   * stop because one worker's links would not load.
   */
  async function runVerify(
    u: AdminUserRow,
    onProgress: (done: number, total: number, note: string) => void
  ): Promise<{ report: VerifyReportShape | null; failed: string }> {
    const who = u.profile?.name || u.name || u.email || 'user'
    let failed = ''
    let last: VerifyReportShape | null = null
    // The freshness cutoff for THIS check, minted by the server and echoed back
    // so links judged a moment ago count as done. Without echoing it, every
    // request would start a new pass and the loop would never finish.
    let since = ''
    for (;;) {
      if (stopVerify.current) break
      const ctl = new AbortController()
      verifyAbort.current = ctl
      let res: Response
      try {
        res = await fetch('/api/admin/verify-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(since ? { userId: u.id, since } : { userId: u.id }),
          signal: ctl.signal,
        })
      } catch {
        // Aborted or dropped. Every link judged before this batch is in the
        // ledger, so resuming re-reads at most this batch.
        if (!stopVerify.current) failed = 'Connection lost — progress saved.'
        break
      } finally {
        verifyAbort.current = null
      }
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { failed = d?.error || 'Verification failed.'; break }
      if (typeof d.since === 'string' && d.since) since = d.since
      last = {
        who,
        username: String(d.username ?? ''),
        checked: Number(d.checked) || 0,
        found: Number(d.found) || 0,
        skipped: Number(d.skipped) || 0,
        pct: d.pct === null ? null : Number(d.pct),
        total: Number(d.total) || 0,
        from: String(d.from ?? ''),
        to: String(d.to ?? ''),
        days: Number(d.days) || 0,
        links: Array.isArray(d.links) ? (d.links as JudgedLinkShape[]) : [],
        comments: Array.isArray(d.comments) ? (d.comments as FoundCommentShape[]) : [],
        blockSample: Number(d.blockSample) || 50,
        blocked: d.blocked
          ? {
              judged: Number(d.blocked.judged) || 0,
              skipped: Number(d.blocked.skipped) || 0,
              rule: String(d.blocked.rule ?? ''),
              pct: d.blocked.pct === null || d.blocked.pct === undefined
                ? null
                : Number(d.blocked.pct),
            }
          : undefined,
        ratioSample: Number(d.ratioSample) || 200,
        ratioMinPct: Number(d.ratioMinPct) || 10,
        autoBlockOn: d.autoBlockOn !== false,
        ruleRate:
          d.ruleRate && Number.isFinite(Number(d.ruleRate.judged))
            ? {
                judged: Number(d.ruleRate.judged),
                found: Number(d.ruleRate.found),
                pct: Number(d.ruleRate.pct),
              }
            : null,
        blockNote: String(d.blockNote ?? ''),
        genres: d.genres && Array.isArray(d.genres.rates) ? d.genres : null,
        genreMinPct: Number(d.genreMinPct) || 10,
        genreSample: Number(d.genreSample) || 50,
      }
      const total = Number(d.total) || 0
      onProgress(total - (Number(d.remaining) || 0), total,
        `${last.found}/${last.checked} link(s) carry their comment`)
      if (d.done) break
    }
    return { report: last, failed }
  }

  /** Serve a paused genre to this worker again (the check paused it). */
  async function liftPause(u: AdminUserRow, g: string) {
    const who = u.profile?.name || u.name || u.email || 'user'
    if (!confirm(`Serve ${GENRE_LABELS[g] ?? g} links to ${who} again?`)) return
    const res = await fetch('/api/admin/genre-pause', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, genre: g }),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      alert(d?.error || 'Could not lift the pause.')
      return
    }
    router.refresh()
  }

  async function verifyUser(u: AdminUserRow) {
    const who = u.profile?.name || u.name || u.email || 'user'
    if (!u.profile?.tiktok_url) {
      alert('This user has no TikTok profile link, so there is no @username to look for.')
      return
    }
    if (!confirm(
      `Check ${who}'s last 300 links?\n\n` +
      'Reads the last 300 links they actually opened — across however many days those ' +
      'span — and checks which carry a comment from their own account. Same reads and ' +
      'same judging as the bulk sweep; only the population differs, so one user\'s ' +
      'number means the same as another\'s. Every link is read again now, not taken ' +
      'from an earlier result. Progress is saved as it goes; stopping and starting ' +
      'again re-reads what it had not finished. Three hundred videos is a few minutes, ' +
      'in several batches — the bar shows where it is.\n\n' +
      'They may be BLOCKED automatically: the rules are on the dashboard under Auto-block ' +
      'rules — nothing found on a sample of judged links, or under a set percentage of a ' +
      'longer one. Same rules as the nightly check, and the report says which one acted. ' +
      'A sample too small to judge blocks nobody, and you can unblock them again.'
    )) return

    stopVerify.current = false
    setVerifyingUser(u.id)
    setVerifyProgress({ who, done: 0, total: 0, note: 'Starting…' })
    try {
      const { report, failed } = await runVerify(u, (done, total, note) =>
        setVerifyProgress({ who, done, total, note })
      )
      if (failed) alert(failed)
      else if (report) setVerifyReport(report)
      router.refresh()
    } catch (e) {
      alert(`Verification error: ${String((e as Error)?.message || e)}`)
    } finally {
      setVerifyingUser(null)
      setVerifyProgress(null)
    }
  }

  // Message compose modal (null = closed). userId null = broadcast to everyone.
  const [composeTarget, setComposeTarget] = useState<{ userId: string | null; label: string } | null>(null)
  const [msgBody, setMsgBody] = useState('')
  const [sending, setSending] = useState(false)

  async function sendMessage() {
    if (!composeTarget || !msgBody.trim()) return
    setSending(true)
    try {
      const res = await fetch('/api/admin/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: msgBody.trim(), userId: composeTarget.userId ?? 'all' }),
      })
      if (res.ok) {
        setComposeTarget(null)
        setMsgBody('')
      }
    } finally {
      setSending(false)
    }
  }

  async function deleteReply(replyId: number) {
    await fetch('/api/admin/message', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyId }),
    })
    router.refresh()
  }

  async function deleteMessage(messageId: number) {
    if (!confirm('Delete this message and all its replies? This affects everyone it was sent to.')) return
    await fetch('/api/admin/message', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId }),
    })
    router.refresh()
  }

  async function setVideoStatus(userId: string, status: string) {
    const prev = data.users.find((u) => u.id === userId)?.videoStatus ?? 'pending'
    await post('/api/admin/video', { userId, status })
    router.refresh()
    pushCmd({
      label: `video → ${status}`,
      undo: () => post('/api/admin/video', { userId, status: prev }).then(() => {}),
      redo: () => post('/api/admin/video', { userId, status }).then(() => {}),
    })
  }

  async function setPaid(id: number, paid: boolean) {
    await post('/api/admin/video/paid', { id, paid })
    router.refresh()
    pushCmd({
      label: `video paid ${paid ? '✓' : '✗'}`,
      undo: () => post('/api/admin/video/paid', { id, paid: !paid }).then(() => {}),
      redo: () => post('/api/admin/video/paid', { id, paid }).then(() => {}),
    })
  }

  // Global on/off for the whole video task.
  const [videoEnabled, setVideoEnabled] = useState(videoTaskEnabled)
  const [promoEnabled, setPromoEnabled] = useState(promoTaskEnabled)
  // Product filter for the "Links clicked" tile. '' = all products.
  const [clickProduct, setClickProduct] = useState('')
  async function toggleVideoTask(enabled: boolean) {
    setVideoEnabled(enabled) // optimistic
    const res = await post('/api/admin/video/toggle', { enabled })
    if (!res.ok) {
      setVideoEnabled(!enabled)
      alert('Could not change the video task setting.')
      return
    }
    router.refresh()
  }

  async function togglePromoTask(enabled: boolean) {
    setPromoEnabled(enabled) // optimistic
    const res = await post('/api/admin/promo/toggle', { enabled })
    if (!res.ok) {
      setPromoEnabled(!enabled)
      alert('Could not change the repost task setting.')
      return
    }
    router.refresh()
  }

  // Accept / reject a single video submission (reject sends the user a reason).
  async function reviewVideo(id: number, status: 'approved' | 'rejected') {
    let reason = ''
    if (status === 'rejected') {
      reason = (window.prompt('Why is this video rejected? (sent to the user)') ?? '').trim()
      if (!reason) return
    }
    const res = await post('/api/admin/video/review', { id, status, reason })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      alert(d?.error || 'Could not update the submission.')
      return
    }
    router.refresh()
  }

  // Most clicks first. slice() so we never mutate data.users in place.
  /**
   * The order the list is read in.
   *
   * Clicks answers "who is working"; pending pay answers "who am I about to
   * pay", which is the question on payout day and was unanswerable without
   * opening every card — the amount lives in each row, so the eye has to do the
   * sorting. Comments is the honest measure of output, since a click is only an
   * intention until a comment lands.
   *
   * The mailbox money is NOT in the pending figure any more (it is settled on the
   * Email tasks page), so this sorts by what the user card would actually pay.
   */
  const sortedUsers = data.users.slice().sort((a, b) => {
    if (userSort === 'pending') {
      const pa = pendingByUser[a.id]?.total ?? 0
      const pb = pendingByUser[b.id]?.total ?? 0
      // Ties fall back to clicks, so a page of zero-balance users is still in a
      // meaningful order rather than whatever the database returned.
      return pb - pa || b.totalClicks - a.totalClicks
    }
    if (userSort === 'comments')
      return genreComments(b, genre) - genreComments(a, genre) || b.totalClicks - a.totalClicks
    if (userSort === 'name') {
      return (a.profile?.name || a.name || a.email).localeCompare(
        b.profile?.name || b.name || b.email
      )
    }
    return b.totalClicks - a.totalClicks
  })

  /**
   * THE REFERRAL TREE: everybody nobody referred at the top level, each followed
   * by the people they brought in, and theirs below them — so a referrer and the
   * workers earning them commission sit together and read as one group.
   *
   * Built from referralByUser (referrer → members). Siblings keep the clicks
   * order. Somebody whose referrer is not in the list (deleted) is a root, and a
   * loop in the data — which recordReferral should never allow — cannot hang
   * the page: each person is placed once.
   */
  const treeDepth = useMemo(() => {
    const depth = new Map<string, number>()
    if (userSort !== 'referrals') return depth
    const ids = new Set(data.users.map((u) => u.id))
    const parentOf = new Map<string, string>()
    for (const [referrer, e] of Object.entries(referralByUser)) {
      if (!ids.has(referrer)) continue
      for (const m of e.members) if (ids.has(m.userId) && m.userId !== referrer) parentOf.set(m.userId, referrer)
    }
    const children = new Map<string, string[]>()
    for (const u of sortedUsers) {
      const p = parentOf.get(u.id)
      if (p) children.set(p, [...(children.get(p) ?? []), u.id])
    }
    const visit = (id: string, d: number) => {
      if (depth.has(id)) return
      depth.set(id, d)
      for (const c of children.get(id) ?? []) visit(c, d + 1)
    }
    for (const u of sortedUsers) if (!parentOf.has(u.id)) visit(u.id, 0)
    for (const u of sortedUsers) visit(u.id, 0) // anything left (a loop) as a root
    return depth
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userSort, data.users, referralByUser, sortedUsers.map((u) => u.id).join(',')])

  const filteredUsers =
    userSort === 'referrals'
      ? (() => {
          // The tree's own order: depth was assigned depth-first, and a Map
          // keeps insertion order, so its keys ARE the order to draw in.
          const byId = new Map(sortedUsers.map((u) => [u.id, u]))
          return Array.from(treeDepth.keys()).map((id) => byId.get(id)!).filter(Boolean)
        })()
      : sortedUsers

  async function doReset() {
    if (resetTarget === null) return
    setResetting(true)
    const isAll = resetTarget === 'all'
    const body = isAll ? {} : { userId: resetTarget }
    try {
      const res = await post('/api/admin/reset', body)
      const d = await res.json().catch(() => ({}))
      router.refresh()
      if (res.ok && d?.undo) {
        const holder = { undo: d.undo }
        pushCmd({
          label: isAll ? 'reset all' : 'reset user',
          undo: () => post('/api/admin/reset', { action: 'restore', ...holder.undo }).then(() => {}),
          redo: async () => {
            const r = await post('/api/admin/reset', body)
            const dd = await r.json().catch(() => ({}))
            holder.undo = dd.undo
          },
        })
      }
    } finally {
      setResetting(false)
      setResetTarget(null)
    }
  }

  async function doDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await fetch('/api/admin/user', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: deleteTarget }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        alert(d?.error || 'Could not delete this user.')
        return
      }
      router.refresh()
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
    }
  }

  // Totals reflect the current product filter.
  const totalUsers = filteredUsers.length
  // Products that actually have clicks, plus the configured list — so a product
  // with no clicks yet is still selectable and reads 0 rather than disappearing.
  // ONLY THIS GENRE'S. Every product of the genre is listed even with no
  // clicks yet, so it reads 0 rather than disappearing; another genre's
  // products are not offered at all, because the clicks behind them have
  // already been cut away on the server and they would read a misleading 0.
  const genreProductList = productsInGenre(genre)
  const clickProducts = genreProductList.slice().sort()
  // The other direction. referralByUser is keyed by REFERRER; an admin looking
  // at a worker wants to know who is being paid a commission on that worker's
  // output, which is the same data read backwards.
  const referredByUser = useMemo(() => {
    const names = new Map(data.users.map((x) => [x.id, x.name || x.email]))
    const out: Record<string, { referrerId: string; name: string | null; code: string }> = {}
    for (const [referrerId, e] of Object.entries(referralByUser)) {
      for (const m of e.members) {
        out[m.userId] = {
          referrerId,
          name: names.get(referrerId) ?? null,
          code: e.code ?? '',
        }
      }
    }
    return out
  }, [referralByUser, data.users])
  const clicksAllProducts = Object.values(data.clicksByProduct).reduce((a, b) => a + b, 0)
  // Per-product totals come from the product stamped on each CLICK, so they don't
  // shift when a user is moved between products (unlike summing users' totals).
  /**
   * What the Links-clicked stat counts, under the product filter.
   *
   * WITHIN THE GENRE. This used to offer whole genres as well as products,
   * because the page showed every genre at once and "how much went to website"
   * meant adding two product rows by eye. The master switch answers that now,
   * so the filter only narrows inside the genre already chosen.
   *
   * Summed from the per-product totals, which come from the product stamped on
   * each CLICK, so the number does not shift when a user is reassigned.
   */
  const totalClicks = clickProduct
    ? (data.clicksByProduct[clickProduct] ?? 0)
    : clicksAllProducts
  const totalCommented = filteredUsers.reduce((s, u) => s + u.totalCommented, 0)
  // This genre's apportioned share of those (see genreCommentShare).
  const genreCommented = filteredUsers.reduce((s, u) => s + genreComments(u, genre), 0)
  // Pending (unapproved) pay across the filtered users, from the per-user data.
  /**
   * Workers who have done nothing for a fortnight, hidden rather than removed.
   *
   * WHY HIDDEN AND NOT DELETED. A list of 161 people where 100 of them stopped
   * weeks ago is a list nobody can read, and the answer to that is a filter, not
   * a destructor: deleting an account throws away their submissions, their
   * screenshots and the record of what they were owed, and it cannot be undone
   * if the rule catches somebody who was on holiday.
   *
   * WORK MEANS ANY WORK — a click, a comment report, a video, a repost, a
   * mailbox — and it is NOT measured from the reset. A reset last Tuesday does
   * not turn a fortnight of silence into three days of it.
   *
   * NEVER-WORKED ACCOUNTS COUNT AS IDLE once they are a fortnight old, which is
   * what catches abandoned sign-ups and test accounts; a new registration gets
   * the same two weeks before it disappears from the list.
   *
   * ANYONE STILL OWED MONEY STAYS VISIBLE, whatever the dates say. Hiding
   * somebody you have not paid is how they stop being paid.
   */
  const IDLE_DAYS = 14
  const idleCutoff = Date.now() - IDLE_DAYS * 86400000
  const isIdle = (u: AdminUserRow): boolean => {
    const p = pendingByUser[u.id]
    const owed =
      (p?.total ?? 0) > 0 ||
      (p?.accounts.birr ?? 0) > 0 ||
      (p?.accountsAwaiting.count ?? 0) > 0
    if (owed) return false
    const last = u.lastWorkAt ? Date.parse(u.lastWorkAt) : Date.parse(u.createdAt)
    return Number.isFinite(last) && last < idleCutoff
  }
  const idleUsers = filteredUsers.filter(isIdle)
  const shownUsers = showIdle ? filteredUsers : filteredUsers.filter((u) => !isIdle(u))

  const pendingSum = filteredUsers.reduce(
    (acc, u) => {
      const p = pendingByUser[u.id]
      if (p) {
        acc.comments += p.comments.birr
        acc.video += p.video.birr
        acc.promo += p.promo.birr
        acc.accounts += p.accounts.birr
        acc.referrals += p.referrals.birr
        acc.waiting += p.accountsAwaiting.count
        acc.total += p.total
      }
      return acc
    },
    { comments: 0, video: 0, promo: 0, accounts: 0, referrals: 0, waiting: 0, total: 0 }
  )

  /**
   * Clicks and money, divided by genre, over the users currently shown.
   *
   * TWO DIFFERENT KINDS OF NUMBER IN ONE TABLE, and the table says which is
   * which:
   *
   *   CLICKS ARE MEASURED. clicked_link.product is stamped at click time, so
   *   every click already knows which genre's video it sent somebody to.
   *
   *   PAY IS APPORTIONED. commented_submission holds a platform, a count and
   *   no product — the app asks "how many TikTok videos did you comment on"
   *   and that is the entire report, so there is nothing in it to divide by.
   *   Each worker's comment pay is therefore split in the proportion of the
   *   links THEY opened in the same window the pay is counted over, and their
   *   referral pay in the proportion their members opened. It is the best the
   *   stored data supports; making it exact means asking the worker to report
   *   per product, which is a change to what the app collects.
   *
   * Video and repost pay are not divided at all: those rows carry no product
   * either and the work is not about one — a promo video is for the job, not
   * for a genre. They are reported on their own line so the parts still add up
   * to the pending total.
   *
   * Computed over the same list pendingSum uses, so the money here and the
   * pending total in the strip above are always two views of one figure.
   */
  const genreSplit = useMemo(() => {
    const rows: Record<string, { clicks: number; comments: number; referrals: number }> = {}
    const row = (g: string) => (rows[g] ??= { clicks: 0, comments: 0, referrals: 0 })
    let flat = 0
    let unsplit = 0
    const apportion = (
      birr: number,
      weights: Record<string, number>,
      key: 'comments' | 'referrals'
    ) => {
      if (birr <= 0) return
      const total = Object.values(weights).reduce((a, b) => a + b, 0)
      // Pay with no clicks behind it in the same window cannot be attributed to
      // anything. Reported as unsplit rather than dropped into the biggest
      // genre, which would be a guess wearing a measurement's clothes.
      if (total <= 0) {
        unsplit += birr
        return
      }
      for (const [g, n] of Object.entries(weights)) row(g)[key] += (birr * n) / total
    }
    for (const u of filteredUsers) {
      for (const [g, n] of Object.entries(u.clicksByGenre ?? {})) row(g).clicks += n
      const p = pendingByUser[u.id]
      if (!p) continue
      flat += p.video.birr + p.promo.birr
      apportion(p.comments.birr, u.payClicksByGenre ?? {}, 'comments')
      apportion(p.referrals.birr, u.referralClicksByGenre ?? {}, 'referrals')
    }
    // GENRES order first so the table reads the same way every time, then
    // anything else (clicks made before products had genres) at the end.
    const keys = [
      ...GENRES.filter((g) => rows[g]),
      ...Object.keys(rows).filter((g) => !GENRES.includes(g as never)),
    ]
    const list = keys.map((g) => ({ genre: g, ...rows[g], pay: rows[g].comments + rows[g].referrals }))
    return {
      list,
      flat,
      unsplit,
      clicks: list.reduce((n, r) => n + r.clicks, 0),
      pay: list.reduce((n, r) => n + r.pay, 0),
    }
  }, [filteredUsers, pendingByUser])

  /**
   * The selected genre's clicks and its share of what is owed.
   *
   * The split above still knows every genre, because the PAY weights are
   * all-genre by design: a worker's comment pay is divided in the proportion of
   * every link they were given, so the other genres have to be in the sum for
   * this genre's share to come out right. Only this genre's row is shown.
   */
  const thisGenre = genreSplit.list.find((r) => r.genre === genre) ?? {
    genre,
    clicks: 0,
    comments: 0,
    referrals: 0,
    pay: 0,
  }

  // Addresses nobody has checked yet. Shown on the Email task button, because
  // that number is the only thing standing between a worker and their pay.
  const accountsWaiting = pendingSum.waiting
  const targetUser =
    resetTarget && resetTarget !== 'all' ? data.users.find((u) => u.id === resetTarget) : null
  const targetName = targetUser
    ? targetUser.profile?.name || targetUser.name || targetUser.email
    : ''

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-4">
        <div>
          <h1 className="text-xl font-bold text-white">Admin dashboard</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Since last reset <span className="text-zinc-400">{fmtDateTime(data.resetAt)}</span>
          </p>
        </div>
        {/* Action bar, in groups.
            Eleven controls need roughly 1,600px and the page is 1,024 wide, so
            this WILL take two lines and has to wrap cleanly. It used to carry
            shrink-0, which forbids shrinking below max-content — so instead of
            wrapping it ran off the side and made the whole page scroll
            sideways. Now it wraps, and each group is its own flex container so
            a break moves whole groups rather than splitting the block threshold
            from the button it belongs to.

            Groups are separated by a wider gap rather than by divider lines: a
            vertical rule is only in the right place while everything is on one
            row, and this is never on one row. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 min-w-0">
          {/* Go somewhere else */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button
              onClick={() => router.push('/admin/links')}
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
            >
              🔗 Links
            </button>
            <button
              onClick={() => router.push('/admin/promo')}
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
            >
              🎬 Promo videos
            </button>
            <button
              onClick={() => router.push('/admin/tasks')}
              title="Company email task — check the addresses workers sent, and approve their pay"
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
            >
              ✉️ Email task
              {accountsWaiting > 0 && (
                <span className="ml-1.5 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-amber-500/25 border border-amber-400/50 tabular-nums">
                  {accountsWaiting}
                </span>
              )}
            </button>
            <button
              onClick={() => router.push('/admin/captcha')}
              title="Solve a captcha that has stopped the liker — from here, on any network. The run posts the puzzle and waits for your answer."
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
            >
              🧩 Captcha
            </button>
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) router.push(`/admin/comments/${e.target.value}`)
              }}
              title="Open a product's comments page to view or regenerate them"
              className="text-sm text-white bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 hover:bg-zinc-700 transition-colors focus:outline-none focus:border-emerald-500"
            >
              <option value="">Product comments…</option>
              {/* Grouped by genre: the comments for a slides product have
                  nothing in common with a humanizer's, so picking one from a
                  flat list of eight invites opening the wrong page. */}
              {[genre].map((g) => (
                <optgroup key={g} label={GENRE_LABELS[g] ?? g}>
                  {productsInGenre(g).map((p) => {
                    // productsInGenre returns strings, so the widened list is
                    // what answers "is this one switched off" here.
                    const off = (DEACTIVATED_PRODUCTS as readonly string[]).includes(p)
                    return (
                      <option key={p} value={p} disabled={off}>
                        {p}
                        {off ? ' (off)' : ''}
                      </option>
                    )
                  })}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Long-running checks. The threshold sits with the button it governs,
              inside the same bordered group, so it reads as that button's
              setting rather than as another control in the row. */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button
              onClick={verifyAll}
              disabled={verifyingAll}
              title="Run the single-user check on every unblocked user who worked in the last 7 days (blocked users are skipped): their last 300 links read again, and the two auto-block rules applied. Slow — a few minutes per person — and stoppable."
              className="text-sm text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-50 rounded-lg px-3 py-1.5 transition-colors"
            >
              {verifyingAll ? '⏳ Verifying all…' : '🔍 Verify all'}
            </button>
            <div
              className={`flex items-center rounded-lg border overflow-hidden ${
                sweeping ? 'border-amber-500/40' : 'border-violet-500/40'
              }`}
            >
              <button
                onClick={runPresenceSweep}
                title="For every user active in the last 7 days, read the comments on the links they opened on their last active day and score how many carry their own comment. Every link is read again now, not taken from an earlier result."
                className={`text-sm px-3 py-1.5 transition-colors ${
                  sweeping
                    ? 'text-amber-200 bg-amber-600/20 hover:bg-amber-600/30'
                    : 'text-white bg-violet-600 hover:bg-violet-500'
                }`}
              >
                {sweeping ? '■ Stop check' : '💬 Check comment presence'}
              </button>
              <label
                className="flex items-center gap-1.5 text-[11px] text-zinc-400 bg-zinc-900/60 pl-2 pr-2 py-1 border-l border-zinc-700"
                title="A user is blocked automatically only when this many of their links have been READ and none carries a comment from their account. Unreadable links do not count toward it, and one comment found anywhere stops it. Lower is harsher: a smaller sample blocks honest workers who hit a run of hidden comments."
              >
                block after
                <input
                  type="number"
                  min={20}
                  max={80}
                  step={5}
                  value={blockSample}
                  onChange={(e) => setBlockSample(e.target.value)}
                  disabled={sweeping}
                  className="w-12 bg-zinc-950 border border-zinc-700 rounded px-1 py-0.5 text-center text-zinc-100 tabular-nums disabled:opacity-50"
                />
                empty
              </label>
            </div>
          </div>

          {/* Acts on every user at once. Kept apart from navigation: these are
              the two controls on this page you cannot take back by clicking
              again, and one of them is one keystroke from wiping the board. */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button
              onClick={() => {
                setMsgBody('')
                setComposeTarget({ userId: null, label: 'all users' })
              }}
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
            >
              ✉️ Message all
            </button>
            <button
              onClick={() => setResetTarget('all')}
              title="Clears every user's clicks, submissions and payments back to zero"
              className="text-sm text-red-200 bg-red-600/20 border border-red-500/50 hover:bg-red-600 hover:text-white rounded-lg px-3 py-1.5 transition-colors"
            >
              Reset all data
            </button>
          </div>

          {/* This session: what you have done, and who you are. */}
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <div className="flex items-center rounded-lg border border-zinc-700 overflow-hidden">
              <button
                onClick={runUndo}
                disabled={histBusy || undoStack.length === 0}
                title={undoStack.length ? `Undo: ${undoStack[undoStack.length - 1].label}` : 'Nothing to undo'}
                className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 disabled:opacity-40 disabled:hover:bg-zinc-800 transition-colors"
              >
                ↶ Undo{undoStack.length ? ` (${undoStack.length})` : ''}
              </button>
              <button
                onClick={runRedo}
                disabled={histBusy || redoStack.length === 0}
                title={redoStack.length ? `Redo: ${redoStack[redoStack.length - 1].label}` : 'Nothing to redo'}
                className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 border-l border-zinc-700 disabled:opacity-40 disabled:hover:bg-zinc-800 transition-colors"
              >
                ↷ Redo{redoStack.length ? ` (${redoStack.length})` : ''}
              </button>
            </div>
            <span className="text-xs text-zinc-500 hidden lg:block" title={adminEmail}>
              {adminEmail}
            </span>
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
      </div>

      {/* Summary stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
        <Stat label="Users" value={totalUsers.toLocaleString()} />
        <Stat
          label="Links clicked"
          value={totalClicks.toLocaleString()}
          hint={clickProduct ? `${clickProduct} only` : `all ${GENRE_LABELS[genre] ?? genre}`}
          control={
            <select
              value={clickProduct}
              onChange={(e) => setClickProduct(e.target.value)}
              title="Show links clicked for one product only"
              className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-300 focus:outline-none focus:border-emerald-500 max-w-[92px]"
            >
              <option value="">All</option>
              {clickProducts.map((p) => (
                <option key={p} value={p}>
                  {p} ({(data.clicksByProduct[p] ?? 0).toLocaleString()})
                </option>
              ))}
            </select>
          }
        />
        {/* NOT SCOPED, and labelled so. A comment report says how many and on
            which site, never which product, so there is nothing to cut it by
            — showing it under a genre name without saying so would imply a
            split that does not exist. */}
        <Stat
          label="Comments"
          value={genreCommented.toLocaleString()}
          hint={`≈ apportioned · ${totalCommented.toLocaleString()} in all genres`}
        />
        {/* THIS GENRE'S SHARE, with the whole beside it. A worker is paid one
            total across every genre, so the genre's figure is apportioned from
            the links they were given; the all-genre total stays in view because
            it is the amount that will actually be paid. */}
        <Stat
          label="Pending pay"
          value={`${fmtBirr(thisGenre.pay)} birr`}
          accent="amber"
          hint={`${GENRE_LABELS[genre] ?? genre} share ~ · ${fmtBirr(pendingSum.total)} owed in all genres`}
        />
        <Stat
          label="Of which video"
          value={`${fmtBirr(pendingSum.video)} birr`}
          accent="amber"
          hint={
            `comments ${fmtBirr(pendingSum.comments)} · repost ${fmtBirr(pendingSum.promo)}` +
            // Email money is NOT in the total beside this one — it is settled on
            // the Email tasks page — so it is named as separate rather than
            // listed alongside the parts that are.
            (pendingSum.accounts > 0
              ? ` · emails ${fmtBirr(pendingSum.accounts)} (separate, on the Email tasks page)`
              : '')
          }
        />
      </div>

      {/* Clicks and pay, per genre. Measured clicks, apportioned money —
          see genreSplit for why the two cannot both be exact. */}
      {genreSplit.list.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
            <div className="text-sm font-semibold text-white">
              🎭 {GENRE_LABELS[genre] ?? genre}: clicks and pay
            </div>
            <div className="text-[11px] text-zinc-500">
              {thisGenre.clicks.toLocaleString()} clicks · {fmtBirr(thisGenre.pay)} birr
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse w-full min-w-[420px]">
              <thead>
                <tr>
                  <th className="text-left text-[11px] uppercase tracking-wide text-zinc-500 font-medium pr-3 py-1">
                    Genre
                  </th>
                  <th
                    className="px-2 py-1 border-l border-zinc-800 text-right text-[11px] uppercase tracking-wide text-zinc-500 font-medium"
                    title="Exact: every click carries the product it was made for."
                  >
                    Links clicked
                  </th>
                  <th
                    className="px-2 py-1 border-l border-zinc-800 text-right text-[11px] uppercase tracking-wide text-zinc-500 font-medium"
                    title="Apportioned: comment reports carry no product, so each worker's comment pay is split by the mix of links they opened."
                  >
                    Comment pay ~
                  </th>
                  <th
                    className="px-2 py-1 border-l border-zinc-800 text-right text-[11px] uppercase tracking-wide text-zinc-500 font-medium"
                    title="Apportioned the same way, but by the mix their referred workers opened — the commission is a share of those people's comments."
                  >
                    Referral pay ~
                  </th>
                  <th className="px-2 py-1 border-l border-zinc-800 text-right text-[11px] uppercase tracking-wide text-zinc-500 font-medium">
                    Owed ~
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* One row: the switch has chosen the genre. The other genres
                    are still in genreSplit because this one's pay is
                    apportioned against them. */}
                {[thisGenre].map((r) => (
                  <tr key={r.genre} className="border-t border-zinc-800/70">
                    <td className="pr-3 py-1 text-zinc-200 whitespace-nowrap">
                      {GENRE_LABELS[r.genre] ?? (r.genre === '(none)' ? 'no product stamped' : r.genre)}
                    </td>
                    <td className="px-2 py-1 border-l border-zinc-800 text-right tabular-nums text-zinc-300">
                      {r.clicks.toLocaleString()}
                      <span className="text-zinc-600">
                        {genreSplit.clicks > 0
                          ? ` ${Math.round((r.clicks / genreSplit.clicks) * 100)}%`
                          : ''}
                      </span>
                    </td>
                    <td className="px-2 py-1 border-l border-zinc-800 text-right tabular-nums text-zinc-400">
                      {fmtBirr(r.comments)}
                    </td>
                    <td className="px-2 py-1 border-l border-zinc-800 text-right tabular-nums text-zinc-400">
                      {fmtBirr(r.referrals)}
                    </td>
                    <td className="px-2 py-1 border-l border-zinc-800 text-right tabular-nums font-semibold text-amber-300">
                      {fmtBirr(r.pay)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* What the split does NOT cover, named rather than hidden, so the
              numbers above can be trusted to be only what they claim. */}
          <div className="mt-2 text-[11px] text-zinc-500 leading-relaxed">
            <span className="text-zinc-400">~</span> apportioned, not measured: a comment report
            says how many and on which site, never which product, so pay is divided in the
            proportion of the links each worker was given in the same period.
            {genreSplit.flat > 0 && (
              <>
                {' '}
                Video and repost pay ({fmtBirr(genreSplit.flat)} birr) is not divided — that
                work is not about a product.
              </>
            )}
            {genreSplit.unsplit > 0 && (
              <>
                {' '}
                <span className="text-amber-300/80">
                  {fmtBirr(genreSplit.unsplit)} birr could not be divided
                </span>{' '}
                — pay from workers with no clicks recorded in the period it covers.
              </>
            )}
          </div>
        </div>
      )}

      {/* Clicks per day, last 7 days (rolling — NOT scoped to the reset) */}
      <DailyClicksTable
        days={data.dailyClicks}
        byProduct={data.dailyClicksByProduct}
        byPlatform={data.dailyClicksByPlatform}
        products={clickProducts}
      />

      {/* When each worker's TikTok account was made. */}
      <TiktokAgeReport users={data.users} accounts={tiktokAccounts} />

      {/* Settings, behind one disclosure.
          These five panels — APK, two task switches, platform limits, active
          products — are things you change occasionally, and stacked open they
          pushed the users list, which is what the page is FOR, below the fold on
          every visit. Collapsed by default; the summary carries the state that
          matters so it rarely needs opening at all. */}
      <details className="group mb-4 rounded-xl border border-zinc-800 bg-zinc-900/40">
        <summary className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 cursor-pointer list-none select-none">
          <span className="text-sm font-semibold text-zinc-200">⚙️ Settings</span>
          <span className="text-xs text-zinc-500">
            <span className={videoEnabled ? 'text-emerald-400' : 'text-zinc-600'}>
              🎬 Video {videoEnabled ? 'on' : 'off'}
            </span>
            {' · '}
            <span className={promoEnabled ? 'text-emerald-400' : 'text-zinc-600'}>
              📢 Repost {promoEnabled ? 'on' : 'off'}
            </span>
            {' · platform limits · active products · app build'}
          </span>
          <span className="ml-auto text-xs text-zinc-600 group-open:hidden">show</span>
          <span className="ml-auto text-xs text-zinc-600 hidden group-open:block">hide</span>
        </summary>

        <div className="border-t border-zinc-800 p-3 space-y-3">
          {/* THE ONE SETTING HERE THAT IS PER GENRE: which of this genre's
              products are served, and where. First, under its own heading, so
              it is not read as one of the all-genre settings below. */}
          <div className="text-[10px] uppercase tracking-wide text-emerald-500/80">
            {GENRE_LABELS[genre] ?? genre} only
          </div>
          <ActiveProducts genre={genre} />
          {/* ── THESE APPLY TO EVERY GENRE ── Said once, above them, so nobody
              changes one under Website and is surprised that Humanizer moved
              too. They are reachable from every switch position on purpose:
              hiding them behind one genre would make them look like that
              genre's setting. */}
          <div className="text-[10px] uppercase tracking-wide text-zinc-600 pt-1">
            Settings below apply to all genres
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <TaskToggle
              title="🎬 Video task (150 birr work)"
              on={videoEnabled}
              onLabel="On — approved users can upload videos."
              offLabel="Off — hidden for all users; uploads are blocked."
              onToggle={toggleVideoTask}
            />
            <TaskToggle
              title={`📢 Repost & earn (${PROMO_PAY_BIRR} birr per link)`}
              on={promoEnabled}
              onLabel="On — users can download promo videos and submit reposted links."
              offLabel="Off — hidden for all users; downloads and link submissions are blocked."
              onToggle={togglePromoTask}
            />
          </div>
          <PlatformLimits />
          {/* The thresholds the nightly check blocks people on. Here rather than
              beside the sweep button: they apply to every check, not to one run. */}
          <BlockRules />
          {/* Which genre gets how much of a worker's list. Above the product
              matrix because it is the coarser decision: the matrix divides the
              humanizer slice between six products, this decides how big that
              slice is. */}
          <GenreMix />
          {/* The account-age gate: how old a TikTok account must be, and which
              video proves ownership. Both are judgements that change with the
              market, so neither needs a deploy. */}
          <VerifySettings />
          <LlmModelPicker />
          <ApkAdmin apk={apk} />
          <GuideVideosAdmin videos={guideVideos} />
        </div>
      </details>

      {/* Users list header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-zinc-300">
          Users
          <span className="text-zinc-600 font-normal"> · sorted by </span>
          <select
            value={userSort}
            onChange={(e) => setUserSort(e.target.value as typeof userSort)}
            title="Clicks: who is working. Pending pay: who you are about to pay, biggest first. Comments: what actually landed. Name: to find somebody."
            className="bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-200 font-normal focus:outline-none focus:border-emerald-500"
          >
            <option value="clicks">clicks</option>
            <option value="pending">pending pay</option>
            <option value="comments">comments</option>
            <option value="name">name</option>
            <option value="referrals">referral tree</option>
          </select>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {idleUsers.length > 0 && (
            <button
              type="button"
              onClick={() => setShowIdle((v) => !v)}
              title={
                `${idleUsers.length} worker(s) have done nothing for ${IDLE_DAYS} days — no ` +
                'clicks, comments, videos, reposts or mailboxes. Nothing is deleted; they are ' +
                'just out of the way. Anyone still owed money is never hidden.'
              }
              className={`text-xs rounded-lg px-2.5 py-1 border transition-colors ${
                showIdle
                  ? 'text-zinc-200 bg-zinc-700 border-zinc-600'
                  : 'text-zinc-400 bg-zinc-900 border-zinc-700 hover:bg-zinc-800'
              }`}
            >
              {showIdle
                ? `hiding nothing · ${idleUsers.length} idle shown`
                : `${idleUsers.length} idle hidden · show`}
            </button>
          )}
          <span className="text-xs text-zinc-600 tabular-nums">
            {shownUsers.length === data.users.length
              ? `${data.users.length} total`
              : `${shownUsers.length} of ${data.users.length}`}
          </span>
        </div>
      </div>

      {data.users.length === 0 ? (
        <p className="text-sm text-zinc-500 py-16 text-center">No users yet.</p>
      ) : (
        <div className="space-y-4">
          {shownUsers.map((u) => {
            // Referral tree: indented under whoever referred them, one step
            // per level, with a line down the left so the group reads as one.
            const depth = userSort === 'referrals' ? (treeDepth.get(u.id) ?? 0) : 0
            const card = (
            <UserCard
              key={u.id}
              genre={genre}
              minAgeDays={minAgeDays}
              payHistory={payAdjustments[u.id] ?? []}
              autoBlocks={autoBlockCounts[u.id] ?? 0}
              u={u}
              pending={pendingByUser[u.id] ?? null}
              referral={referralByUser[u.id] ?? null}
              referredBy={referredByUser[u.id] ?? null}
              appVersion={appVersions[u.id] ?? null}
              latestVersionName={apk?.version ?? null}
              paying={payingUser === u.id}
              onReset={() => setResetTarget(u.id)}
              onDelete={() => setDeleteTarget(u.id)}
              onBlock={(reason) => blockUserWith(u, reason)}
              onUnblock={() => unblockUserAction(u)}
              blocking={blockingUser === u.id}
              onViewScreenshots={() => setShotUser(u)}
              onViewClicks={() => openClicks(u)}
              onVerify={() => verifyUser(u)}
              verifying={verifyingUser === u.id}
              presence={presence[u.id] ?? null}
              presenceDays={presenceHistory[u.id] ?? []}
              pausedGenres={genrePauses[u.id] ?? []}
              onLiftPause={(g) => liftPause(u, g)}
              tiktokAccount={tiktokAccounts[u.id] ?? null}
              onProfileSaved={() => router.refresh()}
              onViewSnapshots={() => openSnapshots(u)}
              onDeductClicks={() => deductUserClicks(u)}
              deducting={deductingUser === u.id}
              onSetVideo={(status) => setVideoStatus(u.id, status)}
              onSetPaid={(id, paid) => setPaid(id, paid)}
              onReviewVideo={reviewVideo}
              onApprove={() => approvePay(u.id)}
              onMarkPaid={() => markPaidPay(u.id)}
              onMessage={() => {
                setMsgBody('')
                setComposeTarget({ userId: u.id, label: u.profile?.name || u.name || u.email })
              }}
              onDeleteReply={deleteReply}
              onDeleteMessage={deleteMessage}
            />
            )
            if (depth === 0) return card
            const by = referredByUser[u.id]
            return (
              <div
                key={u.id}
                style={{ marginLeft: `${Math.min(depth, 6) * 1.5}rem` }}
                className="border-l-2 border-sky-800/60 pl-3"
              >
                <div className="text-[11px] text-sky-400/80 mb-1">
                  ↳ referred by {by?.name || 'another user'}
                </div>
                {card}
              </div>
            )
          })}
        </div>
      )}

      {/* Compose message modal */}
      {composeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-md w-full p-5 max-h-[92vh] overflow-y-auto">
            <h3 className="text-base font-semibold text-white">Message {composeTarget.label}</h3>
            <p className="text-xs text-zinc-500 mt-1 mb-3">
              They&apos;ll see this the next time they open the dashboard.
            </p>
            <textarea
              value={msgBody}
              onChange={(e) => setMsgBody(e.target.value)}
              rows={4}
              placeholder="Type your message…"
              className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setComposeTarget(null)}
                className="px-3 py-1.5 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              >
                Cancel
              </button>
              <button
                onClick={sendMessage}
                disabled={sending || !msgBody.trim()}
                className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirm dialog (all users or a single user) */}
      {resetTarget !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-sm w-full p-5 max-h-[92vh] overflow-y-auto">
            <h3 className="text-base font-semibold text-white">
              {resetTarget === 'all' ? 'Reset all data?' : `Reset ${targetName}'s data?`}
            </h3>
            <p className="text-sm text-zinc-400 mt-2">
              {resetTarget === 'all' ? 'This resets every user' : 'This resets this user'}
              &apos;s click counts, daily stats, and commented totals to
              <span className="text-white"> 0</span> (counting starts fresh from now). Click history
              itself isn&apos;t deleted, so already-opened links stay hidden.{' '}
              <span className="text-amber-300">Uploaded screenshots are permanently deleted.</span>
            </p>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setResetTarget(null)}
                className="px-3 py-1.5 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              >
                Cancel
              </button>
              <button
                onClick={doReset}
                disabled={resetting}
                className="px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
              >
                {resetting ? 'Resetting…' : resetTarget === 'all' ? 'Reset everything' : 'Reset user'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete-user confirm dialog */}
      {deleteTarget !== null &&
        (() => {
          const du = data.users.find((u) => u.id === deleteTarget)
          const name = du ? du.profile?.name || du.name || du.email : 'this user'
          return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
              <div className="bg-zinc-900 border border-red-500/40 rounded-xl max-w-sm w-full p-5 max-h-[92vh] overflow-y-auto">
                <h3 className="text-base font-semibold text-white">⚠️ Delete {name}?</h3>
                <p className="text-sm text-zinc-400 mt-2">
                  This <span className="text-red-300">permanently deletes</span> the user and{' '}
                  <span className="text-white">all of their data</span> — profile, clicks, comments,
                  screenshots, video submissions, repost links, messages and login. Uploaded files are
                  removed too. <span className="text-amber-300">This cannot be undone.</span>
                </p>
                {du?.blocked && (
                  <p className="text-sm text-red-300 mt-2">
                    They are blocked, so deleting them makes the block <b>permanent</b>: their
                    Google email, bank account and TikTok profile can never be used to register
                    again, and they can no longer fix the block themselves.
                  </p>
                )}
                <div className="flex justify-end gap-2 mt-5">
                  <button
                    onClick={() => setDeleteTarget(null)}
                    className="px-3 py-1.5 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={doDelete}
                    disabled={deleting}
                    className="px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Delete user'}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}

      {/* Screenshots modal — grouped by submission day */}
      {shotUser && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-0 py-0 sm:px-4 sm:py-8 overflow-y-auto">
          <div className="bg-zinc-900 border border-zinc-700 rounded-none sm:rounded-xl max-w-3xl w-full p-4 sm:p-5 my-0 sm:my-auto min-h-[100dvh] sm:min-h-0">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-base font-semibold text-white">
                  Screenshots — {shotUser.profile?.name || shotUser.name || shotUser.email}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {shotUser.screenshots.length} since last reset · grouped by submission day
                </p>
              </div>
              <button
                onClick={() => setShotUser(null)}
                className="text-zinc-400 hover:text-white text-sm shrink-0"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {shotUser.screenshots.length === 0 ? (
              <p className="text-sm text-zinc-500 py-8 text-center">No screenshots.</p>
            ) : (
              groupByDay(shotUser.screenshots).map(([day, shots]) => (
                <div key={day} className="mb-5">
                  <div className="text-xs font-medium text-emerald-400 mb-2 pb-1 border-b border-zinc-800">
                    {day} · {shots.length} screenshot{shots.length === 1 ? '' : 's'}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {shots.map((s, i) => (
                      <a
                        key={i}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="relative block"
                        title={`${PLATFORMS.find((p) => p.key === s.platform)?.label ?? s.platform} · ${s.uploaded_at}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={s.url}
                          alt=""
                          className="w-24 h-24 object-cover rounded-lg border border-zinc-700 hover:border-zinc-500"
                        />
                        <span className="absolute bottom-0 left-0 right-0 text-[10px] text-center bg-black/60 text-zinc-200 rounded-b-lg py-0.5">
                          {PLATFORMS.find((p) => p.key === s.platform)?.label ?? s.platform}
                        </span>
                      </a>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Clicked-links modal — every link this user opened, newest first */}
      {clicksUser && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-0 py-0 sm:px-4 sm:py-8 overflow-y-auto">
          <div className="bg-zinc-900 border border-zinc-700 rounded-none sm:rounded-xl max-w-2xl w-full p-4 sm:p-5 my-0 sm:my-auto min-h-[100dvh] sm:min-h-0">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <h3 className="text-base font-semibold text-white">
                  Clicked links — {clicksUser.profile?.name || clicksUser.name || clicksUser.email}
                </h3>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {clicksList === null ? 'Loading…' : `${clicksList.length} link${clicksList.length === 1 ? '' : 's'} opened`}
                </p>
              </div>
              <button
                onClick={() => { setClicksUser(null); setClicksList(null) }}
                className="text-zinc-400 hover:text-white text-sm shrink-0"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {clicksList === null ? (
              <p className="text-sm text-zinc-500 py-8 text-center">Loading…</p>
            ) : clicksList.length === 0 ? (
              <p className="text-sm text-zinc-500 py-8 text-center">This user hasn&apos;t clicked any links.</p>
            ) : (
              <div className="max-h-[65vh] overflow-y-auto divide-y divide-zinc-800">
                {clicksList.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 py-2 text-sm">
                    <span className="shrink-0 w-20 text-xs text-zinc-400">
                      {PLATFORMS.find((p) => p.key === c.platform)?.label ?? c.platform ?? '—'}
                    </span>
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 min-w-0 text-zinc-300 hover:text-emerald-400 break-all"
                    >
                      {c.url}
                    </a>
                    <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                      {c.clicked_at ? new Date(c.clicked_at).toLocaleString() : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Past-state snapshots modal (saved at each "mark paid") */}
      {snapUser && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-0 py-0 sm:px-4 sm:py-8 overflow-y-auto">
          <div className="bg-zinc-900 border border-zinc-700 rounded-none sm:rounded-xl max-w-2xl w-full p-4 sm:p-5 my-0 sm:my-auto min-h-[100dvh] sm:min-h-0">
            <div className="flex items-start justify-between gap-4 mb-4">
              <h3 className="text-base font-semibold text-white">
                Past states — {snapUser.profile?.name || snapUser.name || snapUser.email}
              </h3>
              <button onClick={() => { setSnapUser(null); setSnapList(null); setSnapView(null) }} className="text-zinc-400 hover:text-white text-sm shrink-0">✕</button>
            </div>

            {snapList === null ? (
              <p className="text-sm text-zinc-500 py-8 text-center">Loading…</p>
            ) : snapList.length === 0 ? (
              <p className="text-sm text-zinc-500 py-8 text-center">No saved states yet. One is saved each time you mark this user paid.</p>
            ) : (
              <div className="flex flex-wrap gap-2 mb-4">
                {snapList.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => viewSnapshot(s.id)}
                    className={`text-xs rounded-lg px-2.5 py-1.5 border transition-colors ${snapView && (snapView.snapshot as { snapshotAt?: string })?.snapshotAt && new Date(s.created_at).getTime() === new Date(snapView.created_at).getTime() ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}
                    title={new Date(s.created_at).toLocaleString()}
                  >
                    {s.day}
                  </button>
                ))}
              </div>
            )}

            {snapView && (() => {
              const s = snapView.snapshot as Record<string, unknown>
              const num = (k: string) => Number(s[k] ?? 0)
              const byPlat = (k: string) => (s[k] && typeof s[k] === 'object' ? (s[k] as Record<string, number>) : {})
              const clicksByP = byPlat('clicksByPlatform')
              const commentsByP = byPlat('commentedByPlatform')
              const samples = (s.sampleUrls && typeof s.sampleUrls === 'object' ? (s.sampleUrls as Record<string, string[]>) : {})
              const shots = Array.isArray(s.screenshots) ? (s.screenshots as unknown[]).length : 0
              return (
                <div className="border-t border-zinc-800 pt-4 text-sm">
                  <div className="text-xs text-zinc-500 mb-3">
                    Snapshot from <span className="text-zinc-300">{snapView.day}</span> · saved {new Date(snapView.created_at).toLocaleString()}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
                    {[
                      ['Clicks', num('totalClicks')],
                      ['Comments', num('totalCommented')],
                      ['Reposts', Array.isArray(s.promoLinks) ? (s.promoLinks as unknown[]).length : 0],
                      ['Videos', Array.isArray(s.videoSubmissions) ? (s.videoSubmissions as unknown[]).length : 0],
                      ['Logins', Array.isArray(s.loginDays) ? (s.loginDays as unknown[]).length : 0],
                      ['Screenshots', shots],
                      ['Pending birr', num('pendingTotal')],
                    ].map(([label, val]) => (
                      <div key={String(label)} className="rounded-lg border border-zinc-800 px-2.5 py-1.5">
                        <div className="text-[11px] text-zinc-500">{label}</div>
                        <div className="text-white font-semibold tabular-nums">{typeof val === 'number' ? val.toLocaleString() : String(val)}</div>
                      </div>
                    ))}
                  </div>
                  {(Object.keys(clicksByP).length > 0 || Object.keys(commentsByP).length > 0) && (
                    <div className="text-xs text-zinc-400 mb-2">
                      <span className="text-zinc-500">Per platform — </span>
                      {PLATFORMS.map((p) => `${p.label}: ${clicksByP[p.key] ?? 0} clk / ${commentsByP[p.key] ?? 0} cmt`).join(' · ')}
                    </div>
                  )}
                  {Object.entries(samples).some(([, arr]) => arr?.length) && (
                    <div className="text-xs text-zinc-400">
                      <div className="text-zinc-500 mb-1">Sample links reported:</div>
                      {Object.entries(samples).flatMap(([plat, arr]) => (arr || []).map((u2, i) => (
                        <a key={`${plat}-${i}`} href={u2} target="_blank" rel="noopener noreferrer" className="block text-emerald-400 hover:text-emerald-300 break-all">{u2}</a>
                      )))}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* ── Overlays ───────────────────────────────────────────────────
          Every fixed panel and modal on this page, kept together and out of
          the header.

          They used to sit INSIDE the header's action bar: ~490 lines of
          modal markup between the "Check comment presence" button and
          "Sign out", in a `flex items-center gap-2 justify-end` row. It
          looked right only because every one of them is position:fixed and
          escapes the flow — the first one that was not would have rendered
          as a button in the header — and it meant editing the header meant
          scrolling past five modals to reach the rest of its buttons.
          ──────────────────────────────────────────────────────────── */}
      {/* Comment-presence sweep progress */}
      {sweeping && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] w-[min(92vw,26rem)] rounded-xl border border-violet-500/40 bg-zinc-900/95 shadow-2xl p-3 backdrop-blur">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <span className="text-sm text-zinc-100">Checking comment presence…</span>
            <span className="text-xs text-zinc-500 tabular-nums shrink-0">
              {sweepDone} / {sweepTotal} users
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-violet-500 transition-[width] duration-300"
              style={{ width: sweepTotal > 0 ? `${Math.min(100, (100 * sweepDone) / sweepTotal)}%` : '0%' }}
            />
          </div>
          <div className="flex items-center justify-between gap-2 mt-2">
            <span className="text-xs text-zinc-500 truncate">{sweepNote}</span>
            <button
              onClick={stopSweepNow}
              className="text-xs text-zinc-200 hover:text-white border border-zinc-600 hover:border-zinc-400 rounded px-2 py-0.5 shrink-0"
            >
              Stop
            </button>
          </div>
        </div>
      )}

      {/* Sweep results */}
      {sweepReport && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-black/70 p-0 sm:p-4 overflow-y-auto"
          onClick={() => setSweepReport(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-none sm:rounded-xl w-full max-w-3xl my-0 sm:my-8 min-h-[100dvh] sm:min-h-0"
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const scored = sweepReport.filter((r) => r.pct !== null)
              const avg = scored.length
                ? Math.round(scored.reduce((a, r) => a + (r.pct as number), 0) / scored.length)
                : null
              const sorted = [...sweepReport].sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1))
              // The sweep reports a TikTok handle; the name comes from the user
              // list already loaded here, so the two tables never disagree.
              const nameOf = (id: string) => {
                const u = data.users.find((x) => x.id === id)
                return u?.profile?.name?.trim() || u?.name?.trim() || u?.email || id
              }
              return (
                <>
                  <div className="p-4 border-b border-zinc-800">
                    {/* The sweep is the honesty check people are blocked on, so it
                        reads every genre's links, and so does the per-user
                        presence in the list below. */}
                    <div className="text-sm font-semibold text-white">
                      Comment presence <span className="text-[11px] font-normal text-zinc-500">· sweep over all genres</span>
                    </div>
                    <div className="text-xs text-zinc-400 mt-0.5">
                      {sweepReport.length} user(s) scored
                      {avg !== null && <> · average <span className="text-zinc-200">{avg}%</span></>}
                      {' '}· worst first
                      {sweepReport.some((r) => r.blocked) ? (
                        <> · <span className="text-rose-300">
                          {sweepReport.filter((r) => r.blocked).length} auto-blocked
                        </span> after {sweepSample} empty links</>
                      ) : (
                        <> · none blocked (threshold {sweepSample})</>
                      )}
                    </div>
                  </div>
                  {/* Header and rows share ONE scroller or they stop lining up,
                      and ScrollX fixes the width so filtering cannot remove it. */}
                  <ScrollX min={720}>
                    <div className="flex items-center gap-3 px-4 py-1.5 text-[11px] text-zinc-500 border-b border-zinc-800">
                      <span className="flex-1 min-w-0">user</span>
                      <span className="w-40 shrink-0">tiktok</span>
                      <span className="w-24 shrink-0">last active</span>
                      <span className="w-28 shrink-0 text-right">links</span>
                      <span className="w-14 shrink-0 text-right">score</span>
                    </div>
                    <div className="max-h-[60vh] overflow-y-auto divide-y divide-zinc-800/60">
                      {sorted.map((r) => (
                        <div key={r.userId + r.day} className="flex items-center gap-3 px-4 py-2 text-xs">
                          <span className="flex-1 min-w-0 flex items-center gap-1.5">
                            <button
                              onClick={() => openPresenceDetail(r.userId)}
                              title="Show every link judged for this user, and what they commented"
                              className="truncate text-left text-zinc-200 hover:text-emerald-400 underline decoration-dotted underline-offset-2"
                            >
                              {nameOf(r.userId)}
                              {detailLoading === r.userId && <span className="text-zinc-500"> …</span>}
                            </button>
                            {r.blocked && (
                              <span
                                title={
                                  r.blocked.rule === 'ratio'
                                    ? `Auto-blocked by this sweep: only ${r.blocked.pct ?? 0}% of ${r.blocked.judged} judged links carry their comment`
                                    : r.blocked.rule === 'genres'
                                      ? `Auto-blocked by this sweep: under the genre rule in every genre (${r.blocked.pct ?? 0}% of ${r.blocked.judged} judged)`
                                      : `Auto-blocked by this sweep: no comment found on ${r.blocked.judged} judged links`
                                }
                                className="shrink-0 text-[10px] rounded px-1 py-0.5 border border-rose-500/50 bg-rose-500/15 text-rose-300 whitespace-nowrap"
                              >
                                auto-blocked
                              </span>
                            )}
                          </span>
                          <a
                            href={`https://www.tiktok.com/@${r.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-40 shrink-0 truncate text-sky-400 hover:text-sky-300"
                          >
                            @{r.username}
                          </a>
                          <span className="w-24 shrink-0 text-zinc-500 tabular-nums">{r.day}</span>
                          <span
                            className="w-28 shrink-0 text-right text-zinc-500 tabular-nums"
                            title={
                              r.skipped > 0
                                ? `${r.skipped} link(s) could not be judged and are left out of the score`
                                : 'every sampled link could be judged'
                            }
                          >
                            {r.found}/{r.checked}
                            {r.skipped > 0 && <span className="text-zinc-700"> ·{r.skipped}</span>}
                          </span>
                          <span className="w-14 shrink-0 text-right">
                            {r.pct === null ? (
                              <span className="text-zinc-600">n/a</span>
                            ) : (
                              <span
                                className={`font-semibold rounded px-1.5 py-0.5 border tabular-nums ${presenceTone(r.pct)}`}
                              >
                                {r.pct}%
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </ScrollX>
                  <div className="p-3 border-t border-zinc-800 flex items-center justify-between gap-3">
                    <span className="text-[11px] text-zinc-600">
                      &ldquo;n/a&rdquo; means no link could be judged — not a score of zero.
                    </span>
                    <button
                      onClick={() => setSweepReport(null)}
                      className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-4 py-1.5"
                    >
                      Close
                    </button>
                  </div>
                </>
              )
            })()}
          </div>
        </div>
      )}

      {/* Per-user link breakdown, opened from a name in the presence report. */}
      {detail && (
        <div
          className="fixed inset-0 z-[90] flex items-start justify-center bg-black/70 p-0 sm:p-4 overflow-y-auto"
          onClick={() => setDetail(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-none sm:rounded-xl w-full max-w-4xl my-0 sm:my-8 min-h-[100dvh] sm:min-h-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-zinc-800">
              <div className="text-sm font-semibold text-white">
                {detail.name}
                {detail.username && (
                  <a
                    href={`https://www.tiktok.com/@${detail.username}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-2 text-xs font-normal text-sky-400 hover:text-sky-300"
                  >
                    @{detail.username}
                  </a>
                )}
              </div>
              <div className="text-xs text-zinc-400 mt-0.5">
                last {detail.days} days · <span className="text-emerald-300">{detail.totals.found} found</span>
                {" · "}<span className="text-rose-300">{detail.totals.missing} not found</span>
                {detail.totals.skipped > 0 && (
                  <> · <span className="text-zinc-500">{detail.totals.skipped} unjudgeable</span></>
                )}
              </div>
              {detail.timing.avgGapSec !== null && (
                <div
                  className="text-xs text-zinc-400 mt-1"
                  title={`Averaged over ${detail.timing.gaps} gap(s) between consecutive clicks on the same day, counting only gaps of ${detail.timing.maxGapSec}s or less. ${detail.timing.breaks} longer gap(s) were left out as breaks, along with anything spanning two days. Median: ${detail.timing.medGapSec}s.${detail.timing.truncated ? " The oldest day is excluded: this user has more links than the report shows." : ""}`}
                >
                  pace: <span className="text-zinc-200">{duration(detail.timing.avgGapSec)}</span>
                  {" average between links"}
                  <span className="text-zinc-600">
                    {" "}(gaps under {detail.timing.maxGapSec}s, {detail.timing.gaps} of{' '}
                    {detail.timing.gaps + detail.timing.breaks})
                  </span>
                  {detail.timing.medGapSec !== null && (
                    <span className="text-zinc-600"> · median {duration(detail.timing.medGapSec)}</span>
                  )}
                </div>
              )}
            </div>

            <PresenceTrend
              history={detail.history}
              links={detail.links}
              truncated={detail.timing.truncated}
            />

            <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-zinc-800">
              <button
                onClick={() => analysePresence(detail.userId, detail.days)}
                disabled={analysing}
                title="Send the found/missing links, the comment assigned to each and the video titles to the model, and ask what separates them"
                className="text-xs text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
              >
                {analysing ? 'Analysing…' : '🔎 Analyse'}
              </button>
              <span className="text-[11px] text-zinc-600">
                asks the model what separates the links where the comment appeared from the ones where it did not
              </span>
            </div>

            {analysis && (
              <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/40">
                <div className="text-[11px] text-zinc-500 mb-1">
                  analysis · <span className="text-zinc-600">{analysis.model}</span>
                  {analysis.over > 0 && (
                    <span className="text-zinc-600"> · aggregated over all {analysis.over} judged links</span>
                  )}
                </div>
                <p className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
                  {analysis.text}
                </p>
              </div>
            )}

            {/* Horizontal scroller. These columns are fixed-width and shrink-0,
                so on a narrow screen they overflow rather than squashing. Header
                and rows share ONE scroller or they stop lining up. */}
            <ScrollX min={720}>
              <div className="flex items-center gap-3 px-4 py-1.5 text-[11px] text-zinc-500 border-b border-zinc-800">
                <span className="w-16 shrink-0">result</span>
                <span className="flex-1 min-w-0">link · comment</span>
                <span className="w-16 shrink-0 text-right">views</span>
                <span className="w-16 shrink-0 text-right">hearts</span>
                <span className="w-16 shrink-0 text-right">comments</span>
                <span className="w-20 shrink-0 text-right">clicked</span>
                <span className="w-20 shrink-0 text-right">day</span>
              </div>

              <div className="max-h-[65vh] overflow-y-auto divide-y divide-zinc-800/60">
                {detail.links.length === 0 ? (
                  <p className="text-sm text-zinc-500 py-14 text-center">
                    No judged links for this user in the last {detail.days} days.
                  </p>
                ) : (
                  detail.links.map((l) => (
                    <div key={l.day + l.url} className="flex items-start gap-3 px-4 py-2 text-xs">
                      <span className="w-16 shrink-0 pt-0.5">
                        {!l.judgeable ? (
                          <span
                            title="The comments could not be read in full, so this link counts neither way"
                            className="text-[10px] rounded px-1.5 py-0.5 border border-zinc-600/60 bg-zinc-700/20 text-zinc-400"
                          >
                            skipped
                          </span>
                        ) : l.found ? (
                          <span className="text-[10px] rounded px-1.5 py-0.5 border border-emerald-500/40 bg-emerald-600/20 text-emerald-200">
                            found
                          </span>
                        ) : (
                          <span className="text-[10px] rounded px-1.5 py-0.5 border border-rose-500/40 bg-rose-600/20 text-rose-200">
                            missing
                          </span>
                        )}
                      </span>
                      <span className="flex-1 min-w-0">
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-zinc-400 hover:text-emerald-400"
                        >
                          {l.url}
                        </a>
                        {l.title && (
                          <span className="block truncate text-[11px] text-zinc-500" title={l.title}>
                            {l.title}
                          </span>
                        )}
                        {l.found && (
                          <span className="block mt-0.5 text-zinc-200 break-words">
                            {l.text ? (
                              <>“{l.text}”</>
                            ) : (
                              <span className="text-zinc-600">
                                comment text not captured — judged before it was recorded
                              </span>
                            )}
                          </span>
                        )}
                        {/* What they were TOLD to post. Shown on every row: on a
                            missing link it is the only comment there is, and it is
                            the thing the analysis reasons about. */}
                        <span className="block mt-0.5 text-[11px] break-words">
                          <span className="text-zinc-600">assigned: </span>
                          {l.assigned ? (
                            <span className={l.found ? "text-zinc-500" : "text-amber-300/80"}>
                              “{l.assigned}”
                            </span>
                          ) : (
                            <span className="text-zinc-700">not recorded for this click</span>
                          )}
                        </span>
                        {l.isPhoto && (
                          <span className="inline-block mt-0.5 text-[10px] rounded px-1 py-0.5 border border-violet-500/40 bg-violet-500/15 text-violet-300">
                            🖼 photo
                          </span>
                        )}
                      </span>
                      <span className="w-16 shrink-0 text-right text-zinc-500 tabular-nums pt-0.5">{compact(l.views)}</span>
                      <span className="w-16 shrink-0 text-right text-zinc-500 tabular-nums pt-0.5">{compact(l.hearts)}</span>
                      <span className="w-16 shrink-0 text-right text-zinc-500 tabular-nums pt-0.5">{compact(l.comments)}</span>
                      <span
                        className="w-20 shrink-0 text-right text-zinc-500 tabular-nums pt-0.5"
                        title={l.clickedAt ? new Date(l.clickedAt).toLocaleString() : "no click row — their clicks were reset"}
                      >
                        {clockTime(l.clickedAt)}
                      </span>
                      <span className="w-20 shrink-0 text-right text-zinc-600 tabular-nums pt-0.5">{l.day}</span>
                    </div>
                  ))
                )}
              </div>
            </ScrollX>

            <div className="p-3 border-t border-zinc-800 flex items-center justify-between gap-3">
              <span className="text-[11px] text-zinc-600">
                “—” means the hearts refresh has not reached that link yet, not zero.
              </span>
              <button
                onClick={() => setDetail(null)}
                className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-4 py-1.5"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {detailErr && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[95] text-sm text-red-300 bg-zinc-900 border border-red-500/40 rounded-lg px-4 py-2">
          {detailErr}
          <button
            onClick={() => setDetailErr('')}
            className="ml-3 text-zinc-500 hover:text-zinc-300"
          >
            ✕
          </button>
        </div>
      )}

      {/* Single-user comment-presence report */}
      {verifyReport && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-black/70 p-0 sm:p-4 overflow-y-auto"
          onClick={() => setVerifyReport(null)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-none sm:rounded-xl w-full max-w-3xl my-0 sm:my-8 min-h-[100dvh] sm:min-h-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-zinc-800">
              <div className="flex items-start gap-3">
                <span className="text-2xl leading-none">
                  {verifyReport.pct === null ? '❓' : verifyReport.pct >= 80 ? '✅' : verifyReport.pct >= 50 ? '⚠️' : '❌'}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white">
                    {verifyReport.who}
                    <a
                      href={`https://www.tiktok.com/@${verifyReport.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 font-normal text-sky-400 hover:text-sky-300"
                    >
                      @{verifyReport.username} ↗
                    </a>
                  </div>
                  <div className="text-xs text-zinc-400 mt-0.5">
                    {verifyReport.pct === null ? (
                      <span className="text-amber-400">
                        No link could be judged — nothing to score.
                      </span>
                    ) : (
                      <>
                        Their comment is on{' '}
                        <span className="text-zinc-200">
                          {verifyReport.found} of {verifyReport.checked}
                        </span>{' '}
                        judged link(s) — <span className="text-zinc-200">{verifyReport.pct}%</span>
                      </>
                    )}
                  </div>
                  {/* THE NUMBER THE RULE ACTUALLY USED. Without it the header
                      says 9% and the rule says 10%, and nobody can tell why
                      somebody was spared. */}
                  {verifyReport.ruleRate && verifyReport.ruleRate.judged > 0 && (
                    <div className="text-[11px] mt-1">
                      <span className="text-zinc-500">Block rule reads the newest </span>
                      <span className="text-zinc-300">
                        {verifyReport.ruleRate.judged} judged
                      </span>
                      <span className="text-zinc-500">: </span>
                      <span
                        className={
                          verifyReport.ruleRate.pct < verifyReport.ratioMinPct
                            ? 'text-rose-300'
                            : 'text-zinc-300'
                        }
                      >
                        {verifyReport.ruleRate.found} found — {verifyReport.ruleRate.pct}%
                      </span>
                      <span className="text-zinc-500">
                        {' '}
                        (blocks under {verifyReport.ratioMinPct}%
                        {verifyReport.ruleRate.judged < verifyReport.ratioSample
                          ? `, and needs ${verifyReport.ratioSample} judged`
                          : ''}
                        )
                      </span>
                    </div>
                  )}
                  <div className="text-[11px] text-zinc-600 mt-1">
                    Their last {verifyReport.total} link(s)
                    {verifyReport.days > 0 &&
                      ` across ${verifyReport.days} day(s)`}
                    {verifyReport.from &&
                      ` · ${
                        verifyReport.from === verifyReport.to
                          ? verifyReport.from
                          : `${verifyReport.from} → ${verifyReport.to}`
                      }`}
                    {/* A shortfall here means the pass has not finished — not that
                        a sample was taken of the sample. It works to a deadline
                        and resumes. */}
                    {verifyReport.total > verifyReport.links.length &&
                      ` · ${verifyReport.links.length} read so far, ${(
                        verifyReport.total - verifyReport.links.length
                      ).toLocaleString()} still to read`}
                    {verifyReport.skipped > 0 && ` · ${verifyReport.skipped} could not be judged`}
                  </div>
                </div>
              </div>
            </div>

            {/* THE COMMENTS THEMSELVES, and how often each one turned up.
                The per-link list below says WHERE their comment was; this says
                WHAT it was, which is the part that shows whether somebody is
                working through the bank or pasting one line all day. */}
            {verifyReport.comments.length > 0 && (
              <div className="mx-4 mt-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
                <div className="px-3 py-2 border-b border-zinc-700/60 flex items-baseline gap-2">
                  <span className="text-xs font-semibold text-zinc-200">
                    {verifyReport.comments.length} comment(s) found
                  </span>
                  <span className="text-[11px] text-zinc-500">
                    on {verifyReport.found} link(s) — most used first
                  </span>
                  {/* The one number that tells the two apart at a glance. */}
                  {verifyReport.comments[0].count > 1 && (
                    <span className="text-[11px] text-amber-300/90">
                      most-repeated: ×{verifyReport.comments[0].count}
                    </span>
                  )}
                </div>
                <div className="max-h-56 overflow-y-auto divide-y divide-zinc-800/60">
                  {verifyReport.comments.map((c) => (
                    <div
                      key={c.text}
                      className="flex flex-wrap sm:flex-nowrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5"
                    >
                      <span
                        className={`shrink-0 text-[11px] tabular-nums rounded px-1.5 py-0.5 border ${
                          c.count > 1
                            ? 'text-amber-200 bg-amber-600/15 border-amber-500/40'
                            : 'text-zinc-400 bg-zinc-800 border-zinc-700'
                        }`}
                        title={
                          c.count > 1
                            ? `On ${c.count} of their links, across ${c.days} day(s)`
                            : 'On one link'
                        }
                      >
                        ×{c.count}
                      </span>
                      <span className="order-last sm:order-none basis-full sm:basis-auto flex-1 min-w-0 text-xs text-zinc-300 break-words">
                        {c.text}
                      </span>
                      <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums">
                        {c.firstDay === c.lastDay
                          ? c.firstDay.slice(5)
                          : `${c.firstDay.slice(5)}–${c.lastDay.slice(5)}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* WHAT THIS DID TO THEM. A check that can block somebody has to say
                so where the admin is already looking, not in a toast that has
                gone by the time they read the numbers. */}
            {verifyReport.blocked ? (
              <div className="mx-4 mt-3 rounded-lg border border-rose-500/50 bg-rose-950/40 px-3 py-2">
                <div className="text-xs font-semibold text-rose-200">
                  Blocked automatically — signed out now
                </div>
                <div className="text-[11px] text-rose-300/80 mt-0.5">
                  {/* WHICH RULE, because they describe different behaviour: one is
                      somebody who posts nothing, the other somebody who posts a
                      little and claims a full day. */}
                  {verifyReport.blocked.rule === 'ratio'
                    ? `Only ${verifyReport.blocked.pct ?? 0}% of their last ${verifyReport.blocked.judged} judged links carry their comment — under the ${verifyReport.ratioMinPct}% the rule allows.`
                    : verifyReport.blocked.rule === 'genres'
                      ? `Under ${verifyReport.genreMinPct}% in every genre they have ${verifyReport.genreSample}+ judged links in (${verifyReport.blocked.pct ?? 0}% of ${verifyReport.blocked.judged} together).`
                      : `Their comment was on none of ${verifyReport.blocked.judged} judged link(s)`}
                  {verifyReport.blocked.rule === 'empty' &&
                    verifyReport.blocked.skipped > 0 &&
                    `, with ${verifyReport.blocked.skipped} that could not be read and were not counted against them`}
                  . Reason shown to them: register a different TikTok account. They have been
                  sent “Your account has been paused. Please contact the admin.” — unblock from
                  their row if this is wrong.
                </div>
              </div>
            ) : verifyReport.blockNote ? (
              <div className="mx-4 mt-3 rounded-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2">
                <div className="text-[11px] text-zinc-400">
                  {verifyReport.autoBlockOn ? (
                    <>
                      Auto-block rules (nothing on {verifyReport.blockSample} judged links, or
                      under {verifyReport.ratioMinPct}% of {verifyReport.ratioSample}):{' '}
                    </>
                  ) : (
                    <span className="text-amber-300">Auto-blocking is OFF: </span>
                  )}
                  {verifyReport.blockNote}.
                </div>
              </div>
            ) : null}

            {/* BY GENRE. The genre rule's numbers: a genre under the threshold
                is paused for them while another genre is fine. */}
            {verifyReport.genres && verifyReport.genres.rates.length > 0 && (
              <div className="mx-4 mt-3 rounded-lg border border-zinc-800 px-3 py-2">
                <div className="text-[11px] text-zinc-500 mb-1">
                  By genre — needs {verifyReport.genreMinPct}% on {verifyReport.genreSample}+ judged links
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {verifyReport.genres.rates.map((r) => {
                    const paused = verifyReport.genres!.paused.includes(r.genre)
                    return (
                      <span
                        key={r.genre}
                        title={
                          !r.scored
                            ? `Only ${r.judged} judged link(s) — too few for the genre rule to judge`
                            : paused
                              ? 'Paused by this check: this genre is no longer served to them'
                              : r.below
                                ? 'Under the threshold'
                                : 'Meets the threshold'
                        }
                        className={`text-[11px] rounded px-1.5 py-0.5 border tabular-nums ${
                          !r.scored
                            ? 'border-zinc-700 text-zinc-500'
                            : r.below
                              ? 'border-rose-500/50 bg-rose-500/10 text-rose-300'
                              : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                        }`}
                      >
                        {GENRE_LABELS[r.genre] ?? r.genre} {r.pct}% · {r.found}/{r.judged}
                        {paused ? ' · ⏸ paused' : ''}
                        {verifyReport.genres!.lifted.includes(r.genre) ? ' · ▶ resumed' : ''}
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Horizontal scroller: these rows carry fixed-width columns that
                overflow rather than squash on a narrow screen. */}
            <ScrollX min={720}>
              <div className="max-h-[60vh] overflow-y-auto divide-y divide-zinc-800/60">
                {verifyReport.links.length === 0 ? (
                  <div className="p-6 text-center text-sm text-zinc-500">No links judged yet.</div>
                ) : (
                  verifyReport.links.map((l, i) => (
                    <div
                      key={l.url + i}
                      className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 px-3 sm:px-4 py-2"
                    >
                      <span className="shrink-0 w-6 text-right text-[11px] text-zinc-600 tabular-nums">
                        {i + 1}
                      </span>
                      <span
                        className={`shrink-0 text-xs font-medium rounded-md px-2 py-0.5 border ${
                          l.found
                            ? 'text-emerald-200 bg-emerald-600/20 border-emerald-500/40'
                            : l.judgeable
                              ? 'text-rose-200 bg-rose-600/15 border-rose-500/40'
                              : 'text-amber-200 bg-amber-600/15 border-amber-500/40'
                        }`}
                        title={
                          l.found
                            ? 'Their comment is on this video'
                            : l.judgeable
                              ? 'Every comment was read and theirs is not among them'
                              : 'Could not be judged — link would not resolve, or the video has more comments than TikTok will serve. Left out of the score.'
                        }
                      >
                        {l.found ? 'commented' : l.judgeable ? 'no comment' : 'not judged'}
                      </span>
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 min-w-0 truncate text-xs text-sky-400 hover:text-sky-300"
                      >
                        {l.url}
                      </a>
                      {l.found && l.text && (
                        <span
                          className="order-last sm:order-none basis-full sm:basis-auto sm:shrink-0 min-w-0 sm:max-w-[16rem] break-words sm:truncate text-[11px] text-emerald-300/80"
                          title={l.text}
                        >
                          {l.text}
                        </span>
                      )}
                      {l.day && (
                        <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums">
                          {l.day.slice(5)}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </ScrollX>

            <div className="p-3 border-t border-zinc-800 flex items-center justify-between gap-3">
              <span className="text-[11px] text-zinc-600">
                Links that couldn&apos;t be judged are excluded from the percentage, not counted
                as misses.
              </span>
              <button
                onClick={() => setVerifyReport(null)}
                className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-4 py-1.5"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Verification progress — pinned, because the users table scrolls and the
          row being checked can easily be off screen. */}
      {verifyProgress && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] w-[min(92vw,26rem)] rounded-xl border border-sky-500/40 bg-zinc-900/95 shadow-2xl p-3 backdrop-blur">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <span className="text-sm text-zinc-100 truncate">
              Verifying <span className="text-sky-300">{verifyProgress.who}</span>
            </span>
            <span className="text-xs text-zinc-500 tabular-nums shrink-0">
              {verifyProgress.done} / {verifyProgress.total} links
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-sky-500 transition-[width] duration-300"
              style={{
                width:
                  verifyProgress.total > 0
                    ? `${Math.min(100, (100 * verifyProgress.done) / verifyProgress.total)}%`
                    : '0%',
              }}
            />
          </div>
          {/* Verify all: each user's outcome the moment it is decided. */}
          {verifyingAll && verifyLog.length > 0 && (
            <ul className="mt-2 max-h-32 overflow-y-auto space-y-0.5 text-[11px]">
              {verifyLog.map((l, i) => (
                <li key={i} className={`truncate ${l.blocked ? 'text-red-300' : 'text-zinc-400'}`}>
                  <span className="text-zinc-200">{l.who}</span> · {l.text}
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-2 mt-2">
            <span className="text-xs text-zinc-500 truncate">{verifyProgress.note}</span>
            <button
              onClick={stopVerifyNow}
              className="text-xs text-zinc-200 hover:text-white border border-zinc-600 hover:border-zinc-400 rounded px-2 py-0.5 shrink-0"
            >
              Stop
            </button>
          </div>
        </div>
      )}

    </div>
  )
}

/**
 * This genre's share of a worker's comments.
 *
 * A comment report says how many and on which site, never for which product,
 * so a worker's comments cannot be cut by genre exactly. They are apportioned
 * the way their comment pay is: by the share of their clicks in the same pay
 * window that were for this genre's products. A worker who only clicked
 * humanizer links has all of their comments under Humanizer and none under
 * Website builder. Rounded, because a third of a comment is not a comment.
 */
function genreCommentShare(u: AdminUserRow, genre: string): number {
  const w = u.payClicksByGenre ?? {}
  const total = Object.values(w).reduce((a, b) => a + b, 0)
  if (total <= 0) return genre === DEFAULT_GENRE ? 1 : 0
  return (w[genre] ?? 0) / total
}
function genreComments(u: AdminUserRow, genre: string, n: number = u.totalCommented): number {
  return Math.round(n * genreCommentShare(u, genre))
}

function UserCard({
  u,
  pending,
  referral,
  referredBy,
  appVersion,
  latestVersionName,
  paying,
  onReset,
  onDelete,
  onBlock,
  onUnblock,
  blocking,
  onViewScreenshots,
  onViewClicks,
  onVerify,
  verifying,
  pausedGenres,
  onLiftPause,
  onViewSnapshots,
  onDeductClicks,
  deducting,
  onSetVideo,
  onSetPaid,
  onReviewVideo,
  onApprove,
  onMarkPaid,
  onMessage,
  onDeleteReply,
  onDeleteMessage,
  presence,
  presenceDays,
  tiktokAccount,
  onProfileSaved,
  genre,
  minAgeDays,
  payHistory,
  autoBlocks,
}: {
  /** How many times the check has blocked them automatically. */
  autoBlocks: number
  minAgeDays: number
  /** This user's pending-pay edits, newest first. */
  payHistory: PayAdjustment[]
  /** The admin's master genre: comments shown are this genre's share. */
  genre: string
  /** What this user has earned by referring others, or null if they referred
   *  nobody. */
  referral: ReferralEarnings | null
  /** Who referred THIS user — the other direction, so an admin looking at a
   *  worker can see who is being paid a commission on their work. */
  referredBy: { referrerId: string; name: string | null; code: string } | null
  u: AdminUserRow
  pending: PendingPayments | null
  appVersion: { name: string | null; code: number | null } | null
  latestVersionName: string | null
  paying: boolean
  onReset: () => void
  onDelete: () => void
  onBlock: (reason: 'bank' | 'tiktok' | 'forever') => void
  onUnblock: () => void
  blocking: boolean
  onViewScreenshots: () => void
  onViewClicks: () => void
  onVerify: () => void
  verifying: boolean
  /** Genres the comment check stopped serving them, with its numbers. */
  pausedGenres: { genre: string; pct: number; judged: number; found: number; pausedAt: string }[]
  onLiftPause: (genre: string) => void
  /** Mean of this user's daily comment-presence scores, or null if never scored. */
  /** Re-read the server data after a profile edit, so the row shows the new links. */
  onProfileSaved: () => void
  presence: { pct: number; days: number } | null
  /** Their last 7 daily scores, newest first. */
  presenceDays: PresenceDayShape[]
  /** The numeric TikTok id learned from a comment of theirs, with the handle it
   *  was learned from. Null until a presence check has found one. */
  tiktokAccount: { handle: string; uid: string; source?: 'verified' | 'seen' } | null
  onViewSnapshots: () => void
  onDeductClicks: () => void
  deducting: boolean
  onSetVideo: (status: string) => void
  onSetPaid: (id: number, paid: boolean) => void
  onReviewVideo: (id: number, status: 'approved' | 'rejected') => void
  onApprove: () => void
  onMarkPaid: () => void
  onMessage: () => void
  onDeleteReply: (replyId: number) => void
  onDeleteMessage: (messageId: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [blockMenu, setBlockMenu] = useState(false)
  // The Verify action shows as a small popup next to the cursor while hovering the
  // user. It follows the cursor over the row and freezes once you move onto it.
  const [verifyPop, setVerifyPop] = useState<{ x: number; y: number } | null>(null)
  const verifyHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showVerifyPop = (e: React.MouseEvent) => {
    if (verifyHideTimer.current) { clearTimeout(verifyHideTimer.current); verifyHideTimer.current = null }
    setVerifyPop({ x: e.clientX, y: e.clientY })
  }
  const scheduleHideVerify = () => {
    if (verifyHideTimer.current) clearTimeout(verifyHideTimer.current)
    verifyHideTimer.current = setTimeout(() => setVerifyPop(null), 140)
  }
  const displayName = u.profile?.name || u.name || u.email
  const _validUntil = u.validUntil ? new Date(u.validUntil) : null
  const isVerified = !!_validUntil && _validUntil.getTime() > Date.now()
  const unpaidVideos = u.videoSubmissions.filter((v) => !v.paid).length
  // Editing this user's profile links. Admins need this because every check that
  // matters — comment verification, presence scoring — keys off tiktok_url, so a
  // mistyped handle makes an honest worker look like they never commented.
  // ── When was their TikTok account created? ──────────────────────────────
  // The answer is their numeric account id, which TikTok only ever hands out
  // beside a comment. Presence checks capture it as they judge, so most users
  // already have one here and this costs nothing. For anyone judged before that
  // was being kept, expanding the row looks it up once, from a link the ledger
  // already says carries their comment.
  const tiktokHandle = (u.profile?.tiktok_url ?? '').match(/@([^/?#\s]+)/)?.[1]?.toLowerCase() ?? ''
  const knownUid =
    tiktokAccount && tiktokAccount.handle === tiktokHandle ? tiktokAccount.uid : null
  const [uidLookup, setUidLookup] = useState<{ uid: string | null; note: string } | null>(null)
  const [uidBusy, setUidBusy] = useState(false)
  useEffect(() => {
    if (!open || knownUid || uidLookup || uidBusy || !tiktokHandle) return
    setUidBusy(true)
    fetch(`/api/admin/user-tiktok?userId=${encodeURIComponent(u.id)}`)
      .then((r) => r.json())
      .then((d) => setUidLookup({ uid: d?.uid ?? null, note: d?.note ?? d?.error ?? '' }))
      .catch(() => setUidLookup({ uid: null, note: 'Could not reach TikTok.' }))
      .finally(() => setUidBusy(false))
  }, [open, knownUid, uidLookup, uidBusy, tiktokHandle, u.id])
  const tiktokUid = knownUid ?? uidLookup?.uid ?? null
  const tiktokCreated = accountCreatedAt(tiktokUid)
  // Which of the two sources this id came from. The lazy lookup below reads a
  // link the presence ledger says carries their comment, so it is a scan by
  // another name — only the stored registration check counts as verified.
  const uidSource: 'verified' | 'seen' | null = knownUid
    ? (tiktokAccount?.source ?? 'seen')
    : uidLookup?.uid
      ? 'seen'
      : null

  const [editLinks, setEditLinks] = useState(false)
  const [savingLinks, setSavingLinks] = useState(false)
  const [linkErr, setLinkErr] = useState('')
  const [linkDraft, setLinkDraft] = useState({
    tiktok_url: u.profile?.tiktok_url ?? '',
    youtube_url: u.profile?.youtube_url ?? '',
    instagram_url: u.profile?.instagram_url ?? '',
  })

  async function saveLinks() {
    setSavingLinks(true)
    setLinkErr('')
    try {
      const res = await fetch('/api/admin/user-profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.id, ...linkDraft }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setLinkErr(d?.error || 'Could not save.'); return }
      // TAKEN, NOT REFUSED. A link somebody else held is reassigned rather than
      // rejected — the admin can see both profiles and is the one entitled to
      // decide which is right — but taking an account off somebody's profile
      // must never be silent.
      const taken = Array.isArray(d?.takenFrom) ? d.takenFrom : []
      if (taken.length > 0) {
        const lines = taken.map(
          (t: { platform: string; name: string | null }) =>
            `The ${t.platform} link was taken from ${t.name || 'another user'} \u2014 it is ` +
            'no longer on their profile.'
        )
        alert(['Saved.', '', ...lines].join('\n'))
      }
      setEditLinks(false)
      onProfileSaved()
    } catch {
      setLinkErr('Network error.')
    } finally {
      setSavingLinks(false)
    }
  }

  const unpaidReposts = u.promoLinks.filter((l) => !l.paid).length
  const pendingTotal = pending?.total ?? 0
  const payRouter = useRouter()
  const [editingPay, setEditingPay] = useState(false)
  /**
   * Set their pending pay to a new amount. Written as a comment adjustment on
   * the server, so the commission their referrer earns on them moves with it —
   * the confirmation says by how much before anything is saved.
   */
  async function editPendingPay() {
    if (!pending) return
    const floor = pending.total - pending.comments.birr
    const raw = window.prompt(
      `New pending pay for ${u.profile?.name || u.name || u.email}, in birr.\n\n` +
        `Now: ${fmtBirr(pending.total)} birr. The change is made to their comment pay ` +
        `(${COMMENT_PAY_RATE} birr a comment), so it cannot go below ${fmtBirr(floor)} birr ` +
        '(videos, reposts and referral commission stay as they are).',
      String(pending.total)
    )
    if (raw === null) return
    const total = Number(raw.replace(/[^\d.]/g, ''))
    if (!Number.isFinite(total) || raw.trim() === '') { alert('Type an amount in birr.'); return }
    const deltaComments = Math.round((total - pending.total) / COMMENT_PAY_RATE)
    if (deltaComments === 0) return
    const refDelta = deltaComments * REFERRAL_PAY_RATE
    if (!confirm(
      `Change ${fmtBirr(pending.total)} → ${fmtBirr(pending.total + deltaComments * COMMENT_PAY_RATE)} birr ` +
        `(${deltaComments > 0 ? '+' : ''}${deltaComments} comments)?` +
        (referredBy
          ? `\n\nTheir referrer ${referredBy.name ?? ''} earns ${Math.round(REFERRAL_SHARE * 100)}% of this, ` +
            `so their commission changes by ${refDelta > 0 ? '+' : ''}${fmtBirr(refDelta)} birr too.`
          : '')
    )) return
    setEditingPay(true)
    try {
      const res = await fetch('/api/admin/pay-adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: u.id, total }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not change the pending pay.'); return }
      payRouter.refresh()
    } finally {
      setEditingPay(false)
    }
  }
  // A submission is "unapproved" while it's unpaid AND the admin hasn't approved
  // this user's pending pay yet. Once approved (or paid) it's no longer unapproved.
  const approvedPending = !!pending?.approved
  const unapprovedVideos = approvedPending ? 0 : unpaidVideos
  const unapprovedReposts = approvedPending ? 0 : unpaidReposts

  return (
    <div className="border border-zinc-800 rounded-xl bg-zinc-900/40">
      {/* Verify popup — floats next to the cursor while hovering this user */}
      {verifyPop && (
        <div
          style={{ position: 'fixed', left: verifyPop.x + 10, top: Math.max(8, verifyPop.y - 46), zIndex: 60 }}
          onMouseEnter={() => {
            if (verifyHideTimer.current) { clearTimeout(verifyHideTimer.current); verifyHideTimer.current = null }
          }}
          onMouseLeave={scheduleHideVerify}
        >
          <button
            onClick={() => { setVerifyPop(null); onVerify() }}
            disabled={verifying}
            title="Read the comments on this user's TikTok sample links and check whether their own @username is among the commenters. A match verifies them for the next week."
            className="text-xs font-semibold rounded-lg px-3 py-1.5 border border-sky-500/60 bg-sky-600 text-white shadow-xl hover:bg-sky-500 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            {verifying ? '⏳ verifying…' : '🔍 Verify user'}
          </button>
        </div>
      )}
      {/* ── Compact bar (click to expand) ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
        <button
          onClick={() => setOpen((o) => !o)}
          onMouseEnter={showVerifyPop}
          onMouseLeave={scheduleHideVerify}
          className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
          aria-expanded={open}
        >
          <span className={`text-zinc-500 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
          {u.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={u.image} alt="" className="w-8 h-8 rounded-full shrink-0" />
          )}
          <span className="min-w-0">
            <span className="block text-sm font-medium text-white truncate">{displayName}</span>
            <span className="block text-xs text-zinc-500 truncate">{u.email}</span>
          </span>
        </button>

        {/* Stat chips */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {presence && (
            <span
              title={
                `Comment presence: on average ${presence.pct}% of the links this user opened ` +
                `carry a comment from their own account, across ${presence.days} scored day(s). ` +
                `Expand for the daily breakdown.`
              }
              className={`text-[11px] font-semibold rounded px-1.5 py-0.5 border tabular-nums ${presenceTone(presence.pct)}`}
            >
              💬 {presence.pct}%
            </span>
          )}
          {pausedGenres.map((p) => (
            <button
              key={p.genre}
              type="button"
              onClick={() => onLiftPause(p.genre)}
              title={
                `${GENRE_LABELS[p.genre] ?? p.genre} links are not served to this user: their comment ` +
                `was on ${p.found} of ${p.judged} judged links (${p.pct}%) in that genre, while another ` +
                `genre met the rule. Paused ${p.pausedAt.slice(0, 10)}. Click to serve it again.`
              }
              className="text-[11px] font-semibold rounded px-1.5 py-0.5 border border-orange-500/50 bg-orange-500/15 text-orange-200 hover:bg-orange-500/25"
            >
              ⏸ {GENRE_LABELS[p.genre] ?? p.genre} {p.pct}%
            </button>
          ))}
          {u.videoStatus === 'pending' && (
            <span
              title="This user requested video-task access — expand to approve/reject"
              className="text-[11px] font-semibold text-amber-200 bg-amber-500/20 border border-amber-500/50 rounded px-1.5 py-0.5"
            >
              🎥 video request
            </span>
          )}
          {u.blocked && (() => {
            const rLabel = {
              bank: 'incorrect bank account',
              tiktok: 'restricted TikTok',
              forever: 'forever',
            }[u.blockReason ?? 'forever']
            // An automatic block is a machine's opinion — amber and labelled, so
            // it reads as "look at this" rather than the settled red of a block
            // you decided yourself.
            return (
              <span
                title={
                  (u.blockAuto
                    ? 'Blocked AUTOMATICALLY by the nightly comment check: 50 of their opened links carried no comment from their account. '
                    : 'Blocked by an admin. ') +
                  `Reason: ${rLabel}. ` +
                  (u.blockReason === 'forever'
                    ? 'Hard block — no sign-in.'
                    : 'They can self-unblock by entering a new value on sign-in.') +
                  (u.blockAuto
                    ? ` Automatic blocks so far: ${autoBlocks}. After 3, the next one is permanent.`
                    : '')
                }
                className={`text-[11px] font-semibold rounded px-1.5 py-0.5 border ${
                  u.blockAuto
                    ? 'border-amber-500/50 bg-amber-500/20 text-amber-200'
                    : 'border-red-500/50 bg-red-500/20 text-red-200'
                }`}
              >
                {/* An auto-block always has the same reason, so it is just
                    "auto-blocked"; the reason stays in the tooltip. */}
                {u.blockAuto
                  ? u.blockReason === 'forever'
                    ? '🤖 auto-blocked for good'
                    : `🤖 auto-blocked · ${autoBlocks} of 3`
                  : <>🚫 blocked · {rLabel}</>}
              </span>
            )
          })()}
          <Chip label="clicked" value={u.totalClicks} />
          {/* This genre's share; the all-genre count is in the tooltip. */}
          <Chip
            label="comments"
            value={genreComments(u, genre)}
            title={`≈ ${GENRE_LABELS[genre] ?? genre} share of ${u.totalCommented.toLocaleString()} comment(s) in all genres, apportioned by their clicks`}
          />
          {/* WHEN THEIR TIKTOK ACCOUNT WAS MADE, read from its id — in place of
              the per-day rates and the repost count (reposts are still listed in
              the expanded details). Amber when it is under the minimum account
              age set in the dashboard. */}
          <Chip
            label="tiktok age"
            value={tiktokCreated ? accountAgeWords(tiktokCreated) : '—'}
            accent={tiktokCreated && Date.now() - tiktokCreated.getTime() < minAgeDays * 86400000 ? 'amber' : undefined}
            title={
              tiktokCreated
                ? `Created ${tiktokCreated.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · ${uidSource === 'verified' ? 'from the registration check' : 'seen during a presence scan'}`
                : 'Not known yet — expand the row to look it up'
            }
          />
          {/* videos + logins counts are shown only in the expanded details, not the row */}
          {unapprovedReposts + unapprovedVideos > 0 && (
            <span
              title="Repost/video submissions awaiting your approval"
              className="text-[11px] font-semibold text-amber-200 bg-amber-500/20 border border-amber-500/50 rounded px-1.5 py-0.5"
            >
              {unapprovedReposts + unapprovedVideos} unapproved
            </span>
          )}
          {pendingTotal > 0 ? (
            <Chip label="pending birr" value={fmtBirr(pendingTotal)} accent="amber" />
          ) : (
            <Chip label="pending" value="paid ✓" accent="emerald" />
          )}
          {appVersion && (appVersion.name || appVersion.code != null) &&
            (() => {
              const label = appVersion.name || String(appVersion.code)
              const latest = latestVersionName || ''
              const outdated = !!appVersion.name && !!latest && cmpVersion(latest, appVersion.name) > 0
              return (
                <span
                  title={
                    outdated
                      ? `Running v${label} — latest is v${latest}`
                      : `Running v${label}`
                  }
                  className={`text-[11px] rounded px-1.5 py-0.5 border ${
                    outdated
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                      : 'border-zinc-700 text-zinc-400'
                  }`}
                >
                  📱 v{label}
                  {outdated ? ' ⚠' : ''}
                </span>
              )
            })()}
        </div>

        {/* Block (with reason dropdown) / Unblock user */}
        {u.blocked ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onUnblock()
            }}
            disabled={blocking}
            title="This user is blocked — click to unblock (lets them sign in and register again)"
            className="shrink-0 text-[11px] font-semibold rounded px-2 py-1 border border-emerald-500/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
          >
            {blocking ? '⏳' : '✔ Unblock'}
          </button>
        ) : (
          <div className="relative shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setBlockMenu((v) => !v)
              }}
              disabled={blocking}
              title="Block this user (choose a reason)"
              aria-label="Block user"
              className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              {blocking ? (
                <span className="text-sm">⏳</span>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M5.6 5.6l12.8 12.8" />
                </svg>
              )}
            </button>
            {blockMenu && (
              <>
                {/* click-away backdrop */}
                <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setBlockMenu(false) }} />
                <div
                  className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-zinc-500">Block reason</p>
                  {([
                    { r: 'bank', label: 'Incorrect bank account', hint: 'Asks for a new bank account to sign in' },
                    { r: 'tiktok', label: 'Visibility restricted TikTok', hint: 'Asks for a new TikTok link to sign in' },
                    { r: 'forever', label: 'Block forever', hint: 'No way back — hard block' },
                  ] as const).map(({ r, label, hint }) => (
                    <button
                      key={r}
                      onClick={(e) => {
                        e.stopPropagation()
                        setBlockMenu(false)
                        onBlock(r)
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-zinc-800 transition-colors ${
                        r === 'forever' ? 'text-red-300' : 'text-zinc-200'
                      }`}
                    >
                      <span className="block text-sm">{label}</span>
                      <span className="block text-[11px] text-zinc-500">{hint}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Delete user */}
        <button
          onClick={onDelete}
          title="Delete this user and all their data"
          aria-label="Delete user"
          className="shrink-0 text-zinc-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
      </div>

      {/* ── Expanded detail ───────────────────────────────────────────── */}
      {open && (
        <div className="px-3 pb-3 pt-3 space-y-4 border-t border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onViewSnapshots}
              title={
                u.lastSnapshotDay
                  ? `View this user's saved past states — last saved ${u.lastSnapshotDay}`
                  : 'No past states saved yet (a state is saved each time you mark them paid)'
              }
              className="text-[11px] font-semibold rounded px-1.5 py-0.5 border border-zinc-600 bg-zinc-700/30 text-zinc-300 hover:bg-zinc-700/50 transition-colors"
            >
              🕓 past states{u.lastSnapshotDay ? ` · ${u.lastSnapshotDay}` : ''}
            </button>
          </div>
          {/* Comment presence — the last 7 scored days behind the badge */}
          <div className="rounded-lg border border-zinc-800 p-2.5">
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">
                Comment presence · last 7 days
              </span>
              {presence && (
                <span className="text-[11px] text-zinc-500 tabular-nums">
                  average {presence.pct}% over {presence.days} day(s)
                </span>
              )}
            </div>
            {presenceDays.length === 0 ? (
              <div className="text-xs text-zinc-600">
                Not scored yet. The nightly check covers users who opened links that day, or run
                the sweep from the toolbar.
              </div>
            ) : (
              <div className="space-y-1">
                {presenceDays.map((d) => (
                  <div key={d.day} className="flex items-center gap-2 text-xs">
                    <span className="w-20 shrink-0 text-zinc-500 tabular-nums">{d.day}</span>
                    <span className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden min-w-[3rem]">
                      <span
                        className={`block h-full rounded-full ${
                          d.pct === null
                            ? 'bg-zinc-700'
                            : d.pct >= 80
                              ? 'bg-emerald-500'
                              : d.pct >= 50
                                ? 'bg-amber-500'
                                : 'bg-rose-500'
                        }`}
                        style={{ width: d.pct === null ? '100%' : `${d.pct}%` }}
                      />
                    </span>
                    <span className="w-10 shrink-0 text-right text-zinc-300 tabular-nums">
                      {d.pct === null ? '—' : `${d.pct}%`}
                    </span>
                    <span
                      className="w-32 shrink-0 text-right text-[11px] text-zinc-600 tabular-nums"
                      title={
                        d.skipped > 0
                          ? `${d.skipped} link(s) could not be judged — unresolvable, or more comments than TikTok will serve. They are left out of the percentage rather than counted as misses.`
                          : 'Every sampled link could be judged.'
                      }
                    >
                      {d.found}/{d.checked} link(s)
                      {d.skipped > 0 && <span className="text-zinc-700"> · {d.skipped} skipped</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Account + payout — two compact info blocks */}
          <div className="grid sm:grid-cols-2 gap-3">
            {/* Account */}
            <div className="rounded-lg border border-zinc-800 p-2.5 text-xs text-zinc-400 space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Account</div>
              {/* WHOSE ACCOUNT THIS IS. The block listed a join date, a TikTok
                  age and an id, and never said the person's name — so an expanded
                  card read as a set of facts about nobody in particular, and
                  three of them open at once were impossible to tell apart. */}
              <div>
                <span className="text-zinc-500">Name:</span>{' '}
                <span className="text-zinc-100 font-medium">
                  {u.profile?.name || u.name || <span className="text-zinc-600">(no name)</span>}
                </span>
              </div>
              {/* Both names, when they differ. The one they registered with is
                  what an old payment or a support message will be under. */}
              {u.profile?.name && u.name && u.profile.name !== u.name ? (
                <div>
                  <span className="text-zinc-500">Signed up as:</span>{' '}
                  <span className="text-zinc-300">{u.name}</span>
                </div>
              ) : null}
              <div className="break-all">
                <span className="text-zinc-500">Email:</span>{' '}
                <span className="text-zinc-300">{u.email}</span>
              </div>
              {/* HOW TO ACTUALLY REACH THEM. Registration demands a phone
                  number or a Telegram username precisely because the sign-in
                  email is a Google address nobody reads, and until now the one
                  screen where somebody needs to chase a payment or query a
                  rejected link did not show either of them.

                  Both are links, because that is what they are for: the number
                  dials from a phone, the handle opens the chat. The dash is
                  deliberate rather than the row being hidden - "no Telegram" is
                  something to know before you plan to message them. */}
              <div>
                <span className="text-zinc-500">Phone:</span>{' '}
                {u.profile?.phone ? (
                  <a
                    href={`tel:${u.profile.phone}`}
                    className="text-zinc-200 hover:text-emerald-300"
                    title="Call this number"
                  >
                    {u.profile.phone}
                  </a>
                ) : (
                  <span className="text-zinc-600" title="They registered with a Telegram username instead.">
                    {'—'}
                  </span>
                )}
              </div>
              <div>
                <span className="text-zinc-500">Telegram:</span>{' '}
                {u.profile?.telegram ? (
                  <a
                    href={`https://t.me/${u.profile.telegram}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-400 hover:text-emerald-300"
                    title="Open this chat in Telegram"
                  >
                    @{u.profile.telegram}
                  </a>
                ) : (
                  <span className="text-zinc-600" title="They registered with a phone number instead.">
                    {'—'}
                  </span>
                )}
              </div>
              <div>
                <span className="text-zinc-500">Joined:</span>{' '}
                <span className="text-zinc-200">{fmtDateTime(u.createdAt)}</span>
              </div>
              <div>
                <span className="text-zinc-500">TikTok account created:</span>{' '}
                {tiktokCreated ? (
                  <span
                    className="text-zinc-200"
                    title={
                      `Decoded from their numeric TikTok id (${tiktokUid}), which encodes the ` +
                      `second the account was minted. TikTok publishes this nowhere else.\n\n` +
                      (uidSource === 'verified'
                        ? 'Read from the comment they posted on the verification video when ' +
                          'they registered, from the account they had registered. That is the ' +
                          'id this number is meant to come from.'
                        : 'Captured opportunistically beside one of their comments during a ' +
                          'presence scan, not at registration. Still a real id, but it is ' +
                          'whatever happened to be seen while judging something else.')
                    }
                  >
                    {tiktokCreated.toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                    <span className="text-zinc-500"> · {accountAge(tiktokCreated)}</span>
                    {/* WHERE THE DATE CAME FROM. The registration check watched
                        the account comment; a scan-captured id is a by-product
                        of judging something else and can be stale. An admin
                        deciding whether an account is too new should be able to
                        see which of the two they are looking at. */}
                    <span
                      className={
                        uidSource === 'verified'
                          ? 'ml-1.5 text-[10px] text-emerald-400/80'
                          : 'ml-1.5 text-[10px] text-zinc-600'
                      }
                    >
                      {uidSource === 'verified' ? '· verified' : '· from a scan'}
                    </span>
                  </span>
                ) : uidBusy ? (
                  <span className="text-zinc-600">looking up…</span>
                ) : (
                  <span
                    className="text-zinc-600"
                    title={
                      uidLookup?.note ||
                      (tiktokHandle
                        ? 'Not known yet.'
                        : 'This user has no TikTok profile link, so there is no account to date.')
                    }
                  >
                    unknown
                  </span>
                )}
              </div>
              <div className="break-all">
                <span className="text-zinc-500">ID:</span> <span className="text-zinc-500">{u.id}</span>
              </div>
            </div>

            {/* Payout */}
            <div className="rounded-lg border border-zinc-800 p-2.5 text-xs text-zinc-400 space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1.5">Payout</div>
              <div>
                <span className="text-zinc-500">Bank:</span>{' '}
                <span className="text-zinc-200">{u.profile?.bank_account || '—'}</span>
                {' · '}
                <span className={u.profile?.bank_name ? 'text-zinc-200' : 'text-amber-400'}>
                  {u.profile?.bank_name || 'bank not given yet'}
                </span>
              </div>
              {editLinks ? (
                <div className="space-y-1.5 mt-1">
                  {([
                    ['tiktok_url', 'TikTok', 'https://www.tiktok.com/@handle'],
                    ['youtube_url', 'YouTube', 'https://www.youtube.com/@handle'],
                    ['instagram_url', 'Instagram', 'https://www.instagram.com/handle'],
                  ] as const).map(([key, label, ph]) => (
                    <label key={key} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-zinc-500">{label}</span>
                      <input
                        value={linkDraft[key]}
                        onChange={(e) => setLinkDraft((d) => ({ ...d, [key]: e.target.value }))}
                        placeholder={ph}
                        spellCheck={false}
                        className="flex-1 min-w-0 text-xs text-zinc-100 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 focus:outline-none focus:border-sky-500"
                      />
                    </label>
                  ))}
                  {linkErr && <div className="text-[11px] text-rose-400">{linkErr}</div>}
                  <div className="flex items-center gap-2 pt-0.5">
                    <button
                      onClick={saveLinks}
                      disabled={savingLinks}
                      className="text-[11px] font-medium text-white bg-sky-600 hover:bg-sky-500 disabled:opacity-40 rounded px-2.5 py-1"
                    >
                      {savingLinks ? 'Saving…' : 'Save links'}
                    </button>
                    <button
                      onClick={() => { setEditLinks(false); setLinkErr('') }}
                      disabled={savingLinks}
                      className="text-[11px] text-zinc-400 hover:text-zinc-200 px-2 py-1 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                    <span className="text-[11px] text-zinc-600">
                      Empty removes the link. Verification and presence scoring key off the TikTok
                      one.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ProfileLink label="TikTok" href={u.profile?.tiktok_url} />
                  <ProfileLink label="YouTube" href={u.profile?.youtube_url} />
                  <ProfileLink label="Instagram" href={u.profile?.instagram_url} />
                  <button
                    onClick={() => {
                      setLinkDraft({
                        tiktok_url: u.profile?.tiktok_url ?? '',
                        youtube_url: u.profile?.youtube_url ?? '',
                        instagram_url: u.profile?.instagram_url ?? '',
                      })
                      setLinkErr('')
                      setEditLinks(true)
                    }}
                    title="Change this user's profile links"
                    className="text-[11px] text-zinc-400 hover:text-sky-300 border border-zinc-700 hover:border-sky-600 rounded px-1.5 py-0.5"
                  >
                    ✎ edit
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Per-platform: clicked vs commented */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {PLATFORMS.map((p) => (
              <div key={p.key} className="rounded-lg border border-zinc-800 px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                  <span className={`w-2 h-2 rounded-full ${p.dot}`} />
                  {p.label}
                </div>
                <div className="text-sm text-zinc-200 mt-1 tabular-nums">
                  {u.clicksByPlatform[p.key] ?? 0}
                  <span className="text-zinc-600"> clicked</span>
                </div>
                <div className="text-sm text-zinc-200 tabular-nums">
                  {genreComments(u, genre, u.commentedByPlatform[p.key] ?? 0)}
                  <span className="text-zinc-600"> commented ≈</span>
                </div>
                {u.sampleUrls[p.key]?.length ? (
                  <a
                    href={u.sampleUrls[p.key][0]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-emerald-400 hover:text-emerald-300 truncate block mt-0.5"
                    title={u.sampleUrls[p.key].join('\n')}
                  >
                    sample ↗{u.sampleUrls[p.key].length > 1 ? ` (+${u.sampleUrls[p.key].length - 1})` : ''}
                  </a>
                ) : null}
              </div>
            ))}
          </div>

          {/* Daily clicks & comments — Comments table carries the pay column */}
          <div className="grid lg:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-zinc-500 mb-1">Links clicked per day (since reset)</div>
              <DayTable title="Clicks" rows={u.dailyClicks} />
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">Comments per day (since reset)</div>
              <DayTable title="Comments" rows={u.dailyComments} payRate={COMMENT_PAY_RATE} />
            </div>
          </div>

          {/* Login days + screenshots side by side */}
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs text-zinc-500 mb-1">Login days (since reset) · {u.loginDays.length}</div>
              <div className="text-xs text-zinc-400">
                {u.loginDays.length ? u.loginDays.join(', ') : 'None'}
              </div>
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">
                Screenshots (since reset) · {u.screenshots.length}
              </div>
              {u.screenshots.length === 0 ? (
                <div className="text-xs text-zinc-600">None</div>
              ) : (
                <button
                  onClick={onViewScreenshots}
                  className="text-xs text-emerald-400 hover:text-emerald-300 border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
                >
                  View {u.screenshots.length} screenshot{u.screenshots.length === 1 ? '' : 's'} by day →
                </button>
              )}
            </div>
            <div>
              <div className="text-xs text-zinc-500 mb-1">Clicked links</div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={onViewClicks}
                  className="text-xs text-emerald-400 hover:text-emerald-300 border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
                >
                  View clicked links →
                </button>
                {/* Only for UNVERIFIED users: remove their clicks so links regain quota. */}
                {!isVerified && (
                  <button
                    onClick={onDeductClicks}
                    disabled={deducting}
                    title="Unverified user — remove all their clicks; each link they clicked regains one click of quota"
                    className="text-xs text-amber-300 hover:text-amber-200 border border-amber-600/50 rounded-lg px-2.5 py-1.5 hover:bg-amber-900/20 disabled:opacity-50 transition-colors"
                  >
                    {deducting ? 'Removing…' : '⚠ Give back click quota (unverified)'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Replies from this user */}
          {u.replies.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs text-zinc-500">Replies from this user · {u.replies.length}</div>
                <button
                  onClick={onMessage}
                  className="text-xs text-emerald-400 hover:text-emerald-300"
                  title="Send a message back to this user"
                >
                  Reply →
                </button>
              </div>
              <div className="space-y-1.5">
                {u.replies.map((r) => (
                  <div key={r.id} className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-zinc-200 whitespace-pre-wrap break-words flex-1">{r.body}</p>
                      <button
                        onClick={() => onDeleteReply(r.id)}
                        className="shrink-0 text-[11px] text-red-400 hover:text-red-300"
                        title="Delete this reply"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <p className="text-[10px] text-zinc-600">
                        {r.created_at.slice(0, 16).replace('T', ' ')}
                        {r.toMessage ? ` · re: “${r.toMessage.slice(0, 50)}”` : ''}
                      </p>
                      {r.messageId > 0 && (
                        <button
                          onClick={() => onDeleteMessage(r.messageId)}
                          className="shrink-0 text-[10px] text-zinc-500 hover:text-red-300"
                          title="Delete the message this reply is about (and all its replies)"
                        >
                          delete message
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Video task */}
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="text-xs text-zinc-500">Video task:</span>
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${
                  u.videoStatus === 'approved'
                    ? 'bg-emerald-600/20 text-emerald-300'
                    : u.videoStatus === 'pending'
                      ? 'bg-amber-500/20 text-amber-300'
                      : u.videoStatus === 'rejected'
                        ? 'bg-red-500/20 text-red-300'
                        : 'text-zinc-600'
                }`}
              >
                {u.videoStatus ?? 'no request'}
              </span>
              {u.videoStatus && u.videoStatus !== 'approved' && (
                <button
                  onClick={() => onSetVideo('approved')}
                  className="text-xs text-emerald-400 hover:text-emerald-300 border border-zinc-700 rounded px-2 py-0.5"
                >
                  Approve
                </button>
              )}
              {u.videoStatus && u.videoStatus !== 'rejected' && (
                <button
                  onClick={() => onSetVideo('rejected')}
                  className="text-xs text-red-400 hover:text-red-300 border border-zinc-700 rounded px-2 py-0.5"
                >
                  Reject
                </button>
              )}
            </div>
            {u.videoSubmissions.length === 0 ? (
              <div className="text-xs text-zinc-600">No videos submitted.</div>
            ) : (
              (() => {
                const paidCount = u.videoSubmissions.filter((v) => v.paid).length
                const unpaidCount = u.videoSubmissions.length - paidCount
                return (
                  <div className="space-y-1">
                    <div className="text-xs text-zinc-500">
                      {u.videoSubmissions.length} video(s) · {paidCount} paid ·{' '}
                      <span className="text-amber-300">
                        {unpaidCount} unpaid ({(unpaidCount * VIDEO_PAYMENT_BIRR).toLocaleString()} birr owed)
                      </span>
                    </div>
                    {u.videoSubmissions.map((v) => (
                      <div key={v.id} className="flex items-center gap-2 text-xs">
                        <span>🎬</span>
                        <span className="text-zinc-400 truncate flex-1 min-w-0">
                          {v.filename || 'video'}{' '}
                          <span className="text-zinc-600">{v.uploaded_at.slice(0, 10)}</span>
                        </span>
                        <a
                          href={v.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          download
                          className="text-emerald-400 hover:text-emerald-300 shrink-0"
                        >
                          download ↓
                        </a>
                        <span
                          title={v.status === 'rejected' && v.reject_reason ? `Rejected: ${v.reject_reason}` : undefined}
                          className={`shrink-0 rounded px-1.5 py-0.5 border ${
                            v.status === 'approved'
                              ? 'border-emerald-600/40 bg-emerald-600/15 text-emerald-300'
                              : v.status === 'rejected'
                                ? 'border-red-500/50 bg-red-500/15 text-red-300'
                                : 'border-amber-500/50 bg-amber-500/15 text-amber-200'
                          }`}
                        >
                          {v.status === 'approved' ? 'Accepted' : v.status === 'rejected' ? 'Rejected ⓘ' : 'Review'}
                        </span>
                        {v.status !== 'approved' && (
                          <button
                            onClick={() => onReviewVideo(v.id, 'approved')}
                            className="shrink-0 rounded px-1.5 py-0.5 border border-zinc-700 text-emerald-400 hover:text-emerald-300"
                          >
                            Accept
                          </button>
                        )}
                        {v.status !== 'rejected' && (
                          <button
                            onClick={() => onReviewVideo(v.id, 'rejected')}
                            className="shrink-0 rounded px-1.5 py-0.5 border border-zinc-700 text-red-400 hover:text-red-300"
                          >
                            Reject
                          </button>
                        )}
                        {v.status === 'approved' && !v.paid && (
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 border ${
                              approvedPending
                                ? 'border-emerald-600/40 text-emerald-300'
                                : 'border-amber-500/50 bg-amber-500/15 text-amber-200 font-semibold'
                            }`}
                          >
                            {approvedPending ? 'Approved' : 'Unapproved'}
                          </span>
                        )}
                        <button
                          onClick={() => onSetPaid(v.id, !v.paid)}
                          className={`shrink-0 rounded px-1.5 py-0.5 border ${
                            v.paid
                              ? 'border-emerald-600/40 bg-emerald-600/20 text-emerald-300'
                              : 'border-zinc-700 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {v.paid ? 'Paid ✓' : 'Mark paid'}
                        </button>
                      </div>
                    ))}
                  </div>
                )
              })()
            )}
          </div>

          {/* Repost & earn — links the user submitted */}
          <div>
            <div className="text-xs text-zinc-500 mb-1">Repost &amp; earn links:</div>
            {u.promoLinks.length === 0 ? (
              <div className="text-xs text-zinc-600">No repost links submitted.</div>
            ) : (
              (() => {
                const paidCount = u.promoLinks.filter((l) => l.paid).length
                const unpaidCount = u.promoLinks.length - paidCount
                return (
                  <div className="space-y-1">
                    <div className="text-xs text-zinc-500">
                      {u.promoLinks.length} link(s) · {paidCount} paid ·{' '}
                      <span className="text-amber-300">
                        {unpaidCount} unpaid ({(unpaidCount * PROMO_PAY_BIRR).toLocaleString()} birr owed)
                      </span>
                    </div>
                    {u.promoLinks.map((l) => (
                      <div key={l.id} className="flex items-center gap-2 text-xs">
                        <span className="shrink-0 w-16 truncate text-zinc-500 capitalize">{l.platform}</span>
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-emerald-400 hover:text-emerald-300 truncate flex-1 min-w-0"
                        >
                          {l.url}
                        </a>
                        <span className="text-zinc-600 shrink-0">{l.submitted_at.slice(0, 10)}</span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 border ${
                            l.paid
                              ? 'border-emerald-600/40 bg-emerald-600/20 text-emerald-300'
                              : approvedPending
                                ? 'border-emerald-600/40 text-emerald-300'
                                : 'border-amber-500/50 bg-amber-500/15 text-amber-200 font-semibold'
                          }`}
                        >
                          {l.paid ? 'Paid ✓' : approvedPending ? 'Approved' : 'Unapproved'}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })()
            )}
          </div>

          {/* Pending pay — approve, then mark paid (two separate steps) */}
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <span className="text-xs uppercase tracking-wide text-zinc-500">
                Pending pay
                {pendingTotal > 0 && (
                  <span className={pending?.approved ? 'text-emerald-400' : 'text-amber-300'}>
                    {' · '}({pending?.approved ? 'Approved' : 'Unapproved'})
                  </span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <span className={`text-sm font-bold tabular-nums ${pendingTotal > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>
                  {fmtBirr(pendingTotal)} birr
                </span>
                <button
                  type="button"
                  onClick={() => void editPendingPay()}
                  disabled={editingPay || !pending}
                  title="Change this pending pay. Their referrer's commission on them changes with it."
                  className="text-[11px] text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded px-1.5 py-0.5 disabled:opacity-40"
                >
                  {editingPay ? '…' : '✎ Edit'}
                </button>
              </span>
            </div>
            {/* THE ARITHMETIC, WRITTEN OUT. This was a row of five figures and a
                total in the corner, which asks whoever is approving a payment to
                add up somebody's wages in their head — and gives them no way to
                see that the total already includes the referral share, which is
                the one line people query because it is earned on OTHER people's
                comments.

                So: one line per kind of work, what it is made of, and the sum
                spelled out. Zero lines are left out; a line that is in the total
                but not this person's own work says so. */}
            {/* EVERY EDIT, KEPT. What the pending pay was, what it was changed
                to, by whom and when — the edit itself is folded into "paid" at
                the next payout, so this is the only record it ever differed. */}
            {payHistory.length > 0 && (
              <details className="mb-2 text-[11px]">
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-300">
                  ✎ {payHistory.length} edit{payHistory.length === 1 ? '' : 's'} to this pending pay
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {payHistory.map((h) => (
                    <li key={h.id} className="text-zinc-400 tabular-nums">
                      {new Date(h.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      {' · '}
                      <span className="text-zinc-300">{fmtBirr(h.beforeBirr)}</span>
                      {' → '}
                      <span className="text-amber-300">{fmtBirr(h.afterBirr)}</span> birr
                      {' '}({h.deltaComments > 0 ? '+' : ''}{h.deltaComments} comments)
                      {h.referrerDeltaBirr !== 0 &&
                        ` · referrer ${h.referrerDeltaBirr > 0 ? '+' : ''}${fmtBirr(h.referrerDeltaBirr)}`}
                      {h.byEmail && <span className="text-zinc-600"> · {h.byEmail}</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {pending && (() => {
              const parts = [
                {
                  key: 'comments',
                  label: 'Comments',
                  count: pending.comments.count,
                  unit: `${pending.comments.count} × ${COMMENT_PAY_RATE}`,
                  birr: pending.comments.birr,
                  note: 'their own approved comments',
                  tone: 'text-zinc-300',
                },
                {
                  key: 'referrals',
                  label: 'Referral share',
                  count: pending.referrals.count,
                  unit: `${pending.referrals.count} × ${REFERRAL_PAY_RATE}`,
                  birr: pending.referrals.birr,
                  note:
                    `${Math.round(REFERRAL_SHARE * 100)}% of ${referral?.people ?? 0} ` +
                    'referred user(s) comment pay — other people\u2019s work, paid on top',
                  tone: 'text-sky-300',
                },
                {
                  key: 'video',
                  label: 'Videos',
                  count: pending.video.count,
                  unit: `${pending.video.count} × ${VIDEO_PAYMENT_BIRR}`,
                  birr: pending.video.birr,
                  note: 'approved uploads',
                  tone: 'text-zinc-300',
                },
                {
                  key: 'promo',
                  label: 'Reposts',
                  count: pending.promo.count,
                  unit: `${pending.promo.count} × ${PROMO_PAY_BIRR}`,
                  birr: pending.promo.birr,
                  note: 'approved repost links',
                  tone: 'text-zinc-300',
                },
                // EMAIL WORK IS NOT IN THIS SUM. It is approved and paid on the
                // Email tasks page, one address at a time, by whoever checked it.
                // Adding it here would show the same money in two places and let
                // an approval on this card cover mailboxes settled on that one.
                // It is shown below the total instead, as what that page owes.
              ].filter((x) => x.birr > 0)
              const sum = parts.reduce((n, x) => n + x.birr, 0)
              return (
                <div className="mb-2">
                  {parts.length === 0 ? (
                    <div className="text-xs text-zinc-600">Nothing pending.</div>
                  ) : (
                    <>
                      <div className="text-xs">
                        {parts.map((x) => (
                          <div
                            key={x.key}
                            className="flex flex-wrap items-baseline gap-x-2 py-0.5"
                            title={x.note}
                          >
                            <span className={`w-28 shrink-0 ${x.tone}`}>{x.label}</span>
                            <span className="w-24 shrink-0 text-zinc-600 tabular-nums">
                              {x.unit}
                            </span>
                            <span className="text-zinc-600 hidden sm:inline">{x.note}</span>
                            <span className="ml-auto tabular-nums text-zinc-200">
                              {fmtBirr(x.birr)}
                            </span>
                          </div>
                        ))}
                      </div>
                      {/* The addition itself. Two or more parts is where a total
                          stops being obvious, so that is where it is shown. */}
                      <div className="mt-1 pt-1 border-t border-amber-500/20 flex flex-wrap items-baseline gap-x-2 text-xs">
                        {parts.length > 1 && (
                          <span className="text-zinc-500 tabular-nums">
                            {parts.map((x) => fmtBirr(x.birr)).join(' + ')} =
                          </span>
                        )}
                        <span className="font-semibold tabular-nums text-amber-300">
                          {fmtBirr(sum)} birr
                        </span>
                        <span className="text-zinc-600">total for this user</span>
                      </div>
                      {/* WHICH GENRE THIS WORKER'S MONEY IS FOR.
                          Apportioned, not measured: a comment report carries a
                          platform and a count and no product (see
                          AdminUserRow.payClicksByGenre), so the pay is divided
                          in the proportion of the links this worker was given
                          over the same period, and the referral share in the
                          proportion their members were given.
                          Hidden for a worker whose work is all one genre,
                          because then the split IS the total and the line is
                          noise. That is everybody until the new products are
                          switched on. */}
                      {(() => {
                        const split: Record<string, number> = {}
                        const add = (amount: number, w: Record<string, number>) => {
                          const t = Object.values(w).reduce((a, b) => a + b, 0)
                          if (amount <= 0 || t <= 0) return
                          for (const [g, n] of Object.entries(w)) {
                            split[g] = (split[g] ?? 0) + (amount * n) / t
                          }
                        }
                        add(pending.comments.birr, u.payClicksByGenre ?? {})
                        add(pending.referrals.birr, u.referralClicksByGenre ?? {})
                        const list = Object.entries(split)
                          .filter(([, v]) => v >= 0.01)
                          .sort((a, b) => b[1] - a[1])
                        if (list.length < 2) return null
                        return (
                          <div className="mt-1 text-[11px] text-zinc-500">
                            <span className="text-zinc-600">by genre, apportioned: </span>
                            {list.map(([g, v], i) => (
                              <span key={g}>
                                {i > 0 ? ' \u00b7 ' : ''}
                                <span className="text-zinc-400">
                                  {GENRE_LABELS[g] ?? (g === '(none)' ? 'no product stamped' : g)}
                                </span>{' '}
                                <span className="tabular-nums">{fmtBirr(v)}</span>
                              </span>
                            ))}
                          </div>
                        )
                      })()}
                    </>
                  )}
                  {/* The email task, beside the total rather than inside it. An
                      admin approving this balance needs to know the number exists
                      and that it is somebody else's button. */}
                  {(pending.accounts.count > 0 || pending.accountsAwaiting.count > 0) && (
                    <div className="mt-1.5 pt-1.5 border-t border-zinc-800 text-[11px]">
                      <span className="text-zinc-500">Email task, paid separately: </span>
                      {pending.accounts.count > 0 && (
                        <span className="text-sky-300">
                          {fmtBirr(pending.accounts.birr)} for {pending.accounts.count} checked
                          mailbox(es)
                        </span>
                      )}
                      {pending.accountsAwaiting.count > 0 && (
                        <span className="text-amber-400/90">
                          {pending.accounts.count > 0 ? ' · ' : ''}
                          {fmtBirr(pending.accountsAwaiting.birr)} for{' '}
                          {pending.accountsAwaiting.count} awaiting a check
                        </span>
                      )}
                      <span className="text-zinc-600">
                        {' '}
                        — settle it on the Email tasks page; it is not in the total above.
                      </span>
                    </div>
                  )}
                </div>
              )
            })()}
            {/* The referral arrangement, both directions. An admin approving a
                payment should be able to see who else is being paid because of
                this user's work, and on whose work this user is being paid. */}
            {(referral?.people || referredBy) && (
              <div className="mb-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-zinc-500">
                    Referral username{' '}
                    <code className="text-sky-300">{referral?.code || u.referralCode || '—'}</code>
                  </span>
                  {referredBy && (
                    <span className="text-zinc-500">
                      registered with{' '}
                      <span className="text-zinc-300">{referredBy.name || referredBy.code}</span>
                      &apos;s username
                    </span>
                  )}
                </div>
                {referral && referral.people > 0 && (
                  <div className="mt-1 border-t border-sky-500/15 pt-1">
                    <div className="text-[11px] text-zinc-500 mb-0.5">
                      {referral.people} user(s) registered with this username &mdash;{' '}
                      {Math.round(REFERRAL_SHARE * 100)}% of their comment pay, {fmtBirr(referral.birr)} birr
                      unpaid, {fmtBirr(referral.lifetimeBirr)} birr in total
                    </div>
                    {referral.members.map((m) => (
                      <div key={m.userId} className="flex items-center gap-3 text-[11px]">
                        <span className="flex-1 truncate text-zinc-400">
                          {m.name || <span className="text-zinc-600">(no name)</span>}
                        </span>
                        <span
                          className="w-28 text-right tabular-nums text-zinc-500"
                          title="Comments this person made that are not yet paid to the referrer"
                        >
                          {m.comments} unpaid
                        </span>
                        <span className="w-20 text-right tabular-nums text-sky-300">
                          {fmtBirr(m.comments * REFERRAL_PAY_RATE)}
                        </span>
                        <span
                          className="w-24 text-right tabular-nums text-zinc-600"
                          title="Everything this person has ever earned the referrer"
                        >
                          {fmtBirr(m.lifetimeComments * REFERRAL_PAY_RATE)} total
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={onApprove}
                disabled={paying || pendingTotal <= 0 || pending?.approved}
                className="text-xs text-emerald-300 border border-emerald-500/50 hover:bg-emerald-600/10 rounded-lg px-3 py-1.5 disabled:opacity-50 transition-colors"
                title="Approve this pay — the user sees (Approved). Does not reset counters."
              >
                {pending?.approved ? 'Approved ✓' : paying ? 'Approving…' : 'Approve'}
              </button>
              <button
                onClick={onMarkPaid}
                disabled={paying || pendingTotal <= 0}
                className="text-xs text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 disabled:opacity-50 transition-colors"
                title="Mark paid — records the payout and resets this user's pending counters to 0."
              >
                {paying ? 'Saving…' : 'Mark paid'}
              </button>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-4 border-t border-zinc-800 pt-3">
            <button onClick={onMessage} className="text-xs text-emerald-400 hover:text-emerald-300">
              Message
            </button>
            <button onClick={onReset} className="text-xs text-red-400 hover:text-red-300">
              Reset this user
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Clicks per calendar day for the last week, across all users: a Total row plus
 * one row per product (from the product stamped on each click, so the split is
 * accurate even after users are reassigned).
 *
 * This is a ROLLING window and is deliberately not scoped to the data reset —
 * unlike the per-user tables, which count "since reset".
 */
const PLATFORM_DOT: Record<string, string> = {
  tiktok: 'bg-pink-500',
  youtube_shorts: 'bg-orange-500',
  youtube_videos: 'bg-red-500',
  instagram: 'bg-fuchsia-500',
  reddit: 'bg-amber-600',
}
function platformDot(p: string): string {
  return PLATFORM_DOT[p] ?? 'bg-zinc-600'
}


/**
 * When every worker's TikTok account was created, in one place.
 *
 * The expanded user card has shown this for a while, one person at a time,
 * which is the wrong shape for the question it answers. Nobody wants to know
 * how old ONE account is; they want to know which of these accounts were made
 * last week, because an account minted days before it started working for us is
 * the shape of a throwaway, and the six-year-old one with a real posting
 * history is not.
 *
 * COSTS NOTHING TO SHOW. The ids are already on the page """ + EM + """ the presence checks
 * record a worker's numeric TikTok id as they judge their comments, and the
 * dashboard already passes that map down for the expanded card. The date is
 * arithmetic on the id: its top 32 bits are the unix second the account was
 * minted, which is the only place TikTok publishes this at all.
 *
 * Sorted NEWEST FIRST for the same reason, and the ones with no id yet are
 * named rather than quietly left out """ + EM + """ "we do not know" and "it is old" must
 * not look the same.
 */
function TiktokAgeReport({
  users,
  accounts,
}: {
  users: AdminUserRow[]
  accounts: Record<string, { handle: string; uid: string }>
}) {
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => {
    const out: {
      id: string
      name: string
      handle: string
      created: Date | null
      /** They gave us a TikTok link but no id has been learned from it yet. */
      pending: boolean
    }[] = []
    for (const u of users) {
      const link = u.profile?.tiktok_url ?? ''
      const handle = link.match(/@([^/?#\s]+)/)?.[1]?.toLowerCase() ?? ''
      if (!handle) continue // no TikTok account at all, so nothing to date
      const acc = accounts[u.id]
      // Only an id learned from the handle they use NOW. A worker who changed
      // handle has an id for the old account, and dating that one would be a
      // confident answer to a question nobody asked.
      const uid = acc && acc.handle === handle ? acc.uid : null
      const created = accountCreatedAt(uid)
      out.push({
        id: u.id,
        name: u.profile?.name || u.name || u.email,
        handle,
        created,
        pending: !created,
      })
    }
    // Newest account first; the ones we cannot date go last, under their own
    // heading, rather than sorting as if they were ancient.
    out.sort((a, b) => {
      if (a.pending !== b.pending) return a.pending ? 1 : -1
      return (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0)
    })
    return out
  }, [users, accounts])

  const known = rows.filter((r) => !r.pending)
  if (rows.length === 0) return null

  // Buckets are the summary worth reading at a glance. The first two are the
  // ones that matter: an account younger than the work it is doing.
  const DAY = 86_400_000
  const age = (d: Date) => (Date.now() - d.getTime()) / DAY
  const buckets = [
    { label: 'under 30 days', tone: 'text-red-300', n: known.filter((r) => age(r.created!) < 30).length },
    { label: '1-6 months', tone: 'text-amber-300', n: known.filter((r) => age(r.created!) >= 30 && age(r.created!) < 183).length },
    { label: '6-12 months', tone: 'text-zinc-300', n: known.filter((r) => age(r.created!) >= 183 && age(r.created!) < 365).length },
    { label: 'over a year', tone: 'text-emerald-300', n: known.filter((r) => age(r.created!) >= 365).length },
  ].filter((b) => b.n > 0)

  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex flex-wrap items-baseline justify-between gap-2 text-left"
      >
        <span className="text-sm font-semibold text-white">
          🎂 TikTok account ages
          {/* About the person, not the work: an account is as old as it is in every genre. */}
          <span className="text-[11px] font-normal text-zinc-500"> · every worker, all genres</span>
        </span>
        <span className="text-[11px] text-zinc-500">
          {known.length} of {rows.length} dated
          {buckets.map((b) => (
            <span key={b.label}>
              {' \u00b7 '}
              <span className={b.tone}>{b.n}</span> {b.label}
            </span>
          ))}
          <span className="text-zinc-600"> {open ? '\u25b4' : '\u25be'}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2 overflow-x-auto">
          <table className="text-xs border-collapse w-full min-w-[420px]">
            <thead>
              <tr>
                {['Worker', 'TikTok', 'Account created', 'Age'].map((h, i) => (
                  <th
                    key={h}
                    className={
                      (i === 0 ? 'text-left pr-3' : 'px-2 border-l border-zinc-800 text-left') +
                      ' text-[11px] uppercase tracking-wide text-zinc-500 font-medium py-1'
                    }
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800/70">
                  <td className="pr-3 py-1 text-zinc-300 truncate max-w-[180px]" title={r.name}>
                    {r.name}
                  </td>
                  <td className="px-2 py-1 border-l border-zinc-800">
                    <a
                      href={`https://www.tiktok.com/@${r.handle}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-300/80 hover:text-sky-200 truncate"
                    >
                      @{r.handle}
                    </a>
                  </td>
                  <td className="px-2 py-1 border-l border-zinc-800 tabular-nums text-zinc-400">
                    {r.created ? (
                      fmt(r.created)
                    ) : (
                      <span
                        className="text-zinc-600"
                        title="No numeric id learned for this handle yet. It is recorded the next time a presence check reads one of their comments, or when their row is expanded."
                      >
                        not known yet
                      </span>
                    )}
                  </td>
                  <td
                    className={
                      'px-2 py-1 border-l border-zinc-800 ' +
                      (r.created && age(r.created) < 30 ? 'text-red-300' : 'text-zinc-400')
                    }
                  >
                    {r.created ? accountAge(r.created) : '\u2014'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-zinc-600 leading-relaxed">
            Decoded from each account’s numeric TikTok id, whose top 32 bits are the second it
            was minted — TikTok publishes the date nowhere else. The id is captured by the
            comment-presence checks, so a worker nobody has scored yet reads as
            “not known yet” rather than as an old account.
          </p>
        </div>
      )}
    </div>
  )
}

function DailyClicksTable({
  days,
  byProduct,
  byPlatform,
  products,
}: {
  days: { day: string; count: number }[]
  byProduct: Record<string, { day: string; count: number }[]>
  /** The same days split by the platform stamped on each click. */
  byPlatform: Record<string, { day: string; count: number }[]>
  products: string[]
}) {
  if (days.length === 0) return null
  const total = days.reduce((s, d) => s + d.count, 0)
  const busiest = days.reduce((m, d) => Math.max(m, d.count), 0)
  // Only products that actually saw a click in the window get a row; '(none)'
  // (clicks by users with no product) is shown last when present.
  const rows = [...products, '(none)'].filter((p) => (byProduct[p] ?? []).some((d) => d.count > 0))
  /**
   * The same days rolled up per genre.
   *
   * Summed from byProduct here rather than fetched: a genre is exactly the sum
   * of its products, so a second server aggregate would be a second chance for
   * the two to disagree.
   *
   * It is the coarse cut and goes ABOVE the product rows, which is also the
   * order the question is usually asked in — which pool the week went to
   * first, which advertiser inside it second. Shown only once more than one
   * genre has clicks: a single-genre band is the All row again.
   */
  const genreRows = (() => {
    const acc: Record<string, number[]> = {}
    for (const [p, series] of Object.entries(byProduct)) {
      if (p === '(none)') continue
      const g = genreOfProduct(p)
      const into = (acc[g] ??= days.map(() => 0))
      series.forEach((d, i) => { if (i < into.length) into[i] += d.count })
    }
    const list = GENRES.filter((g) => acc[g]?.some((n) => n > 0)).map((g) => ({
      key: g,
      counts: acc[g],
      total: acc[g].reduce((a, b) => a + b, 0),
    }))
    return list.length > 1 ? list : []
  })()
  const platformRows = Object.entries(byPlatform)
    .map(([key, series]) => ({ key, series, total: series.reduce((n, d) => n + d.count, 0) }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
  const dayLabel = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' })

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div className="text-sm font-semibold text-white">📈 Links clicked per day</div>
        <div className="text-[11px] text-zinc-500">
          last {days.length} days · {total.toLocaleString()} clicks
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse w-full min-w-[420px]">
          <thead>
            <tr>
              <th className="text-left text-[11px] uppercase tracking-wide text-zinc-500 font-medium pr-3 py-1">
                Product
              </th>
              {days.map((d) => (
                <th
                  key={d.day}
                  className="px-2 py-1 border-l border-zinc-800 text-center whitespace-nowrap font-medium"
                  title={d.day}
                >
                  <div className="text-zinc-400">{d.day.slice(5)}</div>
                  <div className="text-[10px] text-zinc-600">{dayLabel(d.day)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="text-zinc-200 font-medium pr-3 py-1 whitespace-nowrap">All</td>
              {days.map((d) => (
                <td
                  key={d.day}
                  className={`px-2 py-1 border-l border-t border-zinc-800 text-center tabular-nums font-semibold ${
                    d.count > 0 && d.count === busiest ? 'text-emerald-300' : 'text-zinc-100'
                  }`}
                  title={d.count === busiest && d.count > 0 ? 'busiest day this week' : undefined}
                >
                  {d.count.toLocaleString()}
                </td>
              ))}
            </tr>
            {genreRows.length > 0 && (
              <tr>
                <td
                  colSpan={days.length + 1}
                  className="text-[10px] uppercase tracking-wide text-zinc-600 pr-3 pt-2 pb-0.5 border-t border-zinc-800"
                >
                  by genre
                </td>
              </tr>
            )}
            {genreRows.map(({ key, counts, total }) => (
              <tr key={`genre-${key}`}>
                <td
                  className="text-zinc-300 pr-3 py-1 whitespace-nowrap"
                  title={`${total.toLocaleString()} click(s) in this window`}
                >
                  {GENRE_LABELS[key] ?? key}
                </td>
                {days.map((d, i) => (
                  <td
                    key={d.day}
                    className="text-zinc-300 px-2 py-1 border-l border-t border-zinc-800 text-center tabular-nums"
                  >
                    {(counts[i] ?? 0).toLocaleString()}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length > 0 && (
              <tr>
                <td
                  colSpan={days.length + 1}
                  className="text-[10px] uppercase tracking-wide text-zinc-600 pr-3 pt-2 pb-0.5 border-t border-zinc-800"
                >
                  by product
                </td>
              </tr>
            )}
            {rows.map((p) => {
              const series = byProduct[p] ?? []
              return (
                <tr key={p}>
                  <td className="text-zinc-400 pr-3 py-1 whitespace-nowrap capitalize">{p}</td>
                  {days.map((d, i) => (
                    <td
                      key={d.day}
                      className="text-zinc-400 px-2 py-1 border-l border-t border-zinc-800 text-center tabular-nums"
                    >
                      {(series[i]?.count ?? 0).toLocaleString()}
                    </td>
                  ))}
                </tr>
              )
            })}
            {platformRows.length > 0 && (
              <tr>
                <td
                  colSpan={days.length + 1}
                  className="text-[10px] uppercase tracking-wide text-zinc-600 pr-3 pt-2 pb-0.5 border-t border-zinc-800"
                >
                  by platform
                </td>
              </tr>
            )}
            {platformRows.map(({ key, series, total }) => (
              <tr key={`plat-${key}`}>
                <td
                  className="text-zinc-400 pr-3 py-1 whitespace-nowrap"
                  title={`${total.toLocaleString()} click(s) in this window`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${platformDot(key)}`} />
                    {CLICK_PLATFORM_LABELS[key] ?? key}
                  </span>
                </td>
                {days.map((d, i) => (
                  <td
                    key={d.day}
                    className="text-zinc-400 px-2 py-1 border-l border-t border-zinc-800 text-center tabular-nums"
                  >
                    {(series[i]?.count ?? 0).toLocaleString()}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Two-row table: top row is the title + each date; bottom row is the values.
// When `payRate` is given, a trailing "Pay (birr)" column shows the total count
// across all days × payRate — the amount owed for those comments.
/**
 * One line per day, days across the columns, with the TOTAL at the end.
 *
 * The total was computed here already — the Comments table needed it to work out
 * the pay — but it was never shown, so reading "how much has this person done
 * since their reset" meant adding up a row of numbers by eye. It is the column
 * the table is actually consulted for.
 */
function DayTable({
  title,
  rows,
  payRate,
}: {
  title: string
  rows: { day: string; count: number }[]
  payRate?: number
}) {
  if (rows.length === 0) return <div className="text-xs text-zinc-600">None</div>
  const total = rows.reduce((s, r) => s + r.count, 0)
  const pay = payRate != null ? total * payRate : null
  // Over the days that HAVE a row, which is what the table shows. Days with
  // nothing on them are not in `rows`, so this is the rate on the days they
  // worked — the row chips carry the other rate, over every day since the reset.
  const perActiveDay = total / Math.max(1, rows.length)
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse min-w-[420px]">
        <tbody>
          <tr>
            <td className="text-zinc-300 font-medium pr-3 py-1 whitespace-nowrap">{title}</td>
            {rows.map((r) => (
              <td
                key={r.day}
                className="text-zinc-400 px-2 py-1 border-l border-zinc-800 text-center whitespace-nowrap tabular-nums"
                title={r.day}
              >
                {r.day.slice(5)}
              </td>
            ))}
            <td className="text-zinc-200 px-2 py-1 border-l-2 border-zinc-700 text-center whitespace-nowrap font-medium">
              Total
            </td>
            {pay != null && (
              <td className="text-emerald-300 px-2 py-1 border-l-2 border-zinc-700 text-center whitespace-nowrap font-medium">
                Pay (birr)
              </td>
            )}
          </tr>
          <tr>
            <td className="pr-3 py-1" />
            {rows.map((r) => (
              <td
                key={r.day}
                className="text-zinc-100 px-2 py-1 border-l border-t border-zinc-800 text-center tabular-nums"
              >
                {r.count}
              </td>
            ))}
            <td
              className="text-white px-2 py-1 border-l-2 border-t border-zinc-700 text-center tabular-nums font-semibold"
              title={
                `${total.toLocaleString()} over ${rows.length} day(s) with any — ` +
                `${perActiveDay.toFixed(1)} a day on the days they worked`
              }
            >
              {total.toLocaleString()}
            </td>
            {pay != null && (
              <td
                className="text-emerald-300 px-2 py-1 border-l-2 border-t border-zinc-700 text-center tabular-nums font-semibold"
                title={`${total} comments × ${payRate}`}
              >
                {fmtBirr(pay)}
              </td>
            )}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// A labelled summary tile for the header strip.
function Stat({
  label,
  value,
  hint,
  accent,
  control,
}: {
  label: string
  value: string
  hint?: string
  accent?: 'emerald' | 'amber'
  /** Optional control (e.g. a filter dropdown) shown beside the label. */
  control?: React.ReactNode
}) {
  const valueCls =
    accent === 'emerald' ? 'text-emerald-300' : accent === 'amber' ? 'text-amber-300' : 'text-white'
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <div className="flex items-center justify-between gap-1">
        <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
        {control}
      </div>
      <div className={`text-base font-semibold tabular-nums ${valueCls}`}>{value}</div>
      {hint && <div className="text-[10px] text-zinc-600 tabular-nums">{hint}</div>}
    </div>
  )
}

// A small inline stat pill used in each user's compact bar.
/**
 * Days from the start of counting to today, inclusive.
 *
 * INCLUSIVE, and never less than one. A user reset this morning has worked for
 * one day, not zero — and dividing by zero puts Infinity on screen next to
 * somebody's name.
 */
function daysSince(fromISO: string): number {
  const from = new Date(`${fromISO}T00:00:00`)
  if (isNaN(from.getTime())) return 1
  const today = new Date()
  const days = Math.floor(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86400000
  ) + 1
  return Math.max(1, days)
}

/** A rate with one decimal, or a whole number when it is one. 12.0 reads as
 *  false precision; 12 is what somebody would say out loud. */
function perDay(total: number, days: number): string {
  const v = total / Math.max(1, days)
  return v >= 10 || Number.isInteger(v) ? Math.round(v).toLocaleString() : v.toFixed(1)
}

function Chip({
  label,
  value,
  accent,
  title,
}: {
  label: string
  value: string | number
  accent?: 'emerald' | 'amber'
  /** Hovered explanation. A rate needs one: the number on its own does not say
   *  what it was divided by, and two admins would read it two ways. */
  title?: string
}) {
  const cls =
    accent === 'emerald'
      ? 'text-emerald-300 border-emerald-600/30'
      : accent === 'amber'
        ? 'text-amber-300 border-amber-500/30'
        : 'text-zinc-300 border-zinc-700'
  return (
    <span
      title={title}
      className={`text-[11px] border rounded px-1.5 py-0.5 whitespace-nowrap tabular-nums ${cls}`}
    >
      <span className="font-semibold">{value}</span> <span className="text-zinc-500">{label}</span>
    </span>
  )
}

function ProfileLink({ label, href }: { label: string; href: string | null | undefined }) {
  if (!href) return <span className="text-zinc-600">{label}: —</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300">
      {label} ↗
    </a>
  )
}
