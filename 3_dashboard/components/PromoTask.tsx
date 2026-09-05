'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  PROMO_PLATFORMS,
  PROMO_PAY_BIRR,
  PROMO_DAILY_LIMIT_PER_PLATFORM,
  PROMO_DOWNLOAD_DAILY_LIMIT,
} from '@/lib/config'
import type { PromoVideoUser } from '@/lib/db'

function fmtCountdown(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

const todayUTC = () => new Date().toISOString().slice(0, 10)

type Caption = { title: string; text: string }
export type CaptionGroup = { product: string; requiredTags: string; captions: Caption[] }

export default function PromoTask({
  videos,
  product,
  captionGroups,
  downloadUsedToday,
  nextDownloadResetMs,
  onReload,
}: {
  videos: PromoVideoUser[]
  product: string | null
  captionGroups: CaptionGroup[]
  downloadUsedToday: boolean
  nextDownloadResetMs: number
  onReload?: () => void
}) {
  const [banner, setBanner] = useState('')
  // Copied caption is tracked by a composite key "product#index".
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  // Ticking clock so the "next download" countdown updates live.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!downloadUsedToday) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [downloadUsedToday])
  const countdown = fmtCountdown(nextDownloadResetMs - now)

  // Links submitted today, per platform, across ALL videos (daily limit is per
  // account per day).
  const submittedTodayByPlatform = useMemo(() => {
    const t = todayUTC()
    const m: Record<string, number> = {}
    for (const v of videos) {
      for (const l of v.myLinks) {
        if (l.submitted_at.slice(0, 10) === t) m[l.platform] = (m[l.platform] ?? 0) + 1
      }
    }
    return m
  }, [videos])

  const totalEarned = videos.reduce((s, v) => s + v.myLinks.length, 0) * PROMO_PAY_BIRR
  const needsLinks = videos.filter((v) => v.downloaded && v.myLinks.length === 0).length

  async function copyCaption(c: Caption, key: string) {
    const ok = await copyText(c.text)
    if (ok) {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1500)
    } else {
      setBanner('Copy failed — select and copy manually.')
    }
  }

  const hasCaptions = captionGroups.some((g) => g.captions.length > 0)

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white">Repost &amp; earn</h1>
        <Link
          href="/"
          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Links
        </Link>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Download a video, post it to your own dedicated{' '}
        <span className="text-zinc-300">{product ?? 'product'}</span> account on each platform, then
        submit the link. You earn{' '}
        <span className="text-emerald-400 font-medium">{PROMO_PAY_BIRR} birr</span> per platform link.
        You can download <span className="text-zinc-300">{PROMO_DOWNLOAD_DAILY_LIMIT} video per day</span>{' '}
        and post at most{' '}
        <span className="text-zinc-300">{PROMO_DAILY_LIMIT_PER_PLATFORM}</span> per account per day.
      </p>

      {downloadUsedToday && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 mb-4">
          <p className="text-sm text-amber-200/90">
            ⏳ You&apos;ve used today&apos;s download. Next download in{' '}
            <span className="font-semibold tabular-nums">{countdown}</span>. (You can still re-download
            a video you already got, and submit links.)
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-xs rounded-lg border border-emerald-600/30 text-emerald-300 px-2.5 py-1">
          Earned: <span className="font-semibold">{totalEarned.toLocaleString()} birr</span>
        </span>
      </div>

      {needsLinks > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 mb-4">
          <p className="text-sm text-amber-200/90">
            ⏰ You downloaded {needsLinks} video{needsLinks === 1 ? '' : 's'} but haven&apos;t submitted
            the link{needsLinks === 1 ? '' : 's'} yet. After you upload to your account, paste the link
            below to get paid.
          </p>
        </div>
      )}
      {banner && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-2 mb-4 flex items-start gap-3">
          <p className="text-sm text-zinc-200 flex-1">{banner}</p>
          <button onClick={() => setBanner('')} className="text-xs text-zinc-500 hover:text-zinc-300">
            ✕
          </button>
        </div>
      )}

      {/* ── Captions: click to copy title + tags (read-only) ──────────────── */}
      {captionGroups.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-zinc-300 mb-1">Captions — click one to copy</h2>
          <p className="text-xs text-zinc-500 mb-3">
            Each copies the title <span className="text-zinc-400">and</span> its tags together. You can
            add more tags, but the required ones must stay.
          </p>
          {!hasCaptions ? (
            <p className="text-sm text-zinc-600">Captions are being prepared — check back shortly.</p>
          ) : (
            captionGroups.map((g) => (
              <div key={g.product} className="mb-4">
                {captionGroups.length > 1 && (
                  <div className="text-xs font-medium text-emerald-400 mb-1.5">
                    For <span className="text-zinc-200">{g.product}</span>
                  </div>
                )}
                <p className="text-[11px] text-zinc-600 mb-2 break-words">
                  Required tags: <span className="text-zinc-400">{g.requiredTags}</span>
                </p>
                <div className="space-y-2">
                  {g.captions.map((c, i) => {
                    const key = `${g.product}#${i}`
                    return (
                      <button
                        key={key}
                        onClick={() => copyCaption(c, key)}
                        className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 hover:border-zinc-600 hover:bg-zinc-900 transition-colors group"
                        title="Click to copy title + tags"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-zinc-100 break-words">{c.title}</div>
                            <div className="text-xs text-emerald-400/80 mt-1 break-words whitespace-pre-wrap">
                              {c.text.split('\n\n')[1]}
                            </div>
                          </div>
                          <span
                            className={`shrink-0 text-xs rounded px-2 py-1 transition-colors ${
                              copiedKey === key
                                ? 'bg-emerald-600 text-white'
                                : 'bg-zinc-800 text-zinc-400 group-hover:bg-zinc-700 group-hover:text-zinc-200'
                            }`}
                          >
                            {copiedKey === key ? 'Copied ✓' : 'Copy'}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Videos ────────────────────────────────────────────────────────── */}
      <h2 className="text-sm font-semibold text-zinc-300 mb-2">Videos to repost</h2>
      {videos.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-4xl mb-3">📭</p>
          <p className="text-lg font-medium text-zinc-300">No videos to repost yet</p>
          <p className="text-sm text-zinc-500 mt-2">Check back soon — the admin will add videos here.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {videos.map((v) => (
            <VideoCard
              key={v.id}
              v={v}
              submittedTodayByPlatform={submittedTodayByPlatform}
              // Locked only for a NOT-yet-downloaded video once the daily quota
              // is used. Already-downloaded videos can always be re-downloaded.
              downloadLocked={downloadUsedToday && !v.downloaded}
              countdown={countdown}
              onBanner={setBanner}
              onReload={onReload}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function VideoCard({
  v,
  submittedTodayByPlatform,
  downloadLocked,
  countdown,
  onBanner,
  onReload,
}: {
  v: PromoVideoUser
  submittedTodayByPlatform: Record<string, number>
  downloadLocked: boolean
  countdown: string
  onBanner: (msg: string) => void
  onReload?: () => void
}) {
  const router = useRouter()
  const reload = onReload ?? (() => router.refresh())
  const [downloading, setDownloading] = useState(false)

  async function onDownload() {
    setDownloading(true)
    try {
      const res = await fetch('/api/promo/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: v.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        onBanner(d?.error || 'Download is locked right now.')
        reload()
        return
      }
      // Only open the file once the server allowed (and recorded) the download.
      window.open(v.url, '_blank', 'noopener,noreferrer')
      onBanner('Downloaded. After you upload it to your account, submit the link below to get paid.')
      reload()
    } catch {
      onBanner('Network error.')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="border border-zinc-800 rounded-xl bg-zinc-900/40 overflow-hidden">
      {/* Portrait-friendly: short-form videos (TikTok / Reels / Shorts) are
          vertical, so center the clip and cap its height instead of stretching
          it full-width. Landscape clips still fit within the same height. */}
      <div className="flex justify-center bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={v.url}
          controls
          className="max-h-[70vh] max-w-full w-auto object-contain"
          preload="metadata"
        />
      </div>
      <div className="p-4 space-y-4">
        {v.product && (
          <span className="inline-block text-[11px] rounded px-1.5 py-0.5 border border-emerald-500/30 text-emerald-300">
            {v.product}
          </span>
        )}
        {downloadLocked ? (
          <div className="inline-flex flex-col gap-0.5">
            <button
              disabled
              className="inline-flex items-center gap-2 text-sm text-zinc-500 bg-zinc-800 rounded-lg px-4 py-2 cursor-not-allowed"
            >
              🔒 Download locked
            </button>
            <span className="text-[11px] text-zinc-500 tabular-nums">Next download in {countdown}</span>
          </div>
        ) : (
          <button
            onClick={onDownload}
            disabled={downloading}
            className="inline-flex items-center gap-2 text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 disabled:opacity-50 transition-colors"
          >
            {downloading ? 'Preparing…' : v.downloaded ? '⬇ Download again' : '⬇ Download video'}
          </button>
        )}

        <div>
          <div className="text-xs text-zinc-500 mb-1.5">Submit the link you posted (one per account)</div>
          <div className="space-y-2">
            {PROMO_PLATFORMS.map((p) => {
              const already = v.myLinks.filter((l) => l.platform === p.key)
              const lockedToday = (submittedTodayByPlatform[p.key] ?? 0) >= PROMO_DAILY_LIMIT_PER_PLATFORM
              return (
                <PlatformSubmit
                  key={p.key}
                  videoId={v.id}
                  platformKey={p.key}
                  platformLabel={p.label}
                  existing={already}
                  lockedToday={lockedToday && already.length === 0}
                  onBanner={onBanner}
                  onReload={onReload}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function PlatformSubmit({
  videoId,
  platformKey,
  platformLabel,
  existing,
  lockedToday,
  onBanner,
  onReload,
}: {
  videoId: number
  platformKey: string
  platformLabel: string
  existing: { id: number; url: string; paid: boolean }[]
  lockedToday: boolean
  onBanner: (msg: string) => void
  onReload?: () => void
}) {
  const router = useRouter()
  const reload = onReload ?? (() => router.refresh())
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!url.trim()) return
    setBusy(true)
    try {
      const res = await fetch('/api/promo/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId, platform: platformKey, url: url.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        setUrl('')
        onBanner(`${platformLabel} link submitted — ${PROMO_PAY_BIRR} birr added.`)
        reload()
      } else {
        onBanner(d?.error || 'Could not submit link.')
      }
    } catch {
      onBanner('Network error.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-400 w-16 shrink-0">{platformLabel}</span>
      {existing.length > 0 ? (
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
          {existing.map((l) => (
            <a
              key={l.id}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-emerald-400 hover:text-emerald-300 truncate max-w-[12rem]"
            >
              {l.url}
            </a>
          ))}
          <span className="text-[11px] rounded px-1.5 py-0.5 bg-emerald-600/20 text-emerald-300">
            submitted{existing.some((l) => l.paid) ? ' · paid ✓' : ''}
          </span>
        </div>
      ) : lockedToday ? (
        <span className="flex-1 text-xs text-zinc-600">Daily limit reached — try tomorrow.</span>
      ) : (
        <>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={`Paste your ${platformLabel} link`}
            className="flex-1 min-w-0 bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={submit}
            disabled={busy || !url.trim()}
            className="shrink-0 text-xs text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 disabled:opacity-50"
          >
            {busy ? '…' : 'Submit'}
          </button>
        </>
      )}
    </div>
  )
}
