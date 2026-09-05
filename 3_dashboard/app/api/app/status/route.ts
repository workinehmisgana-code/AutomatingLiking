import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import {
  getHourlyClickTimes,
  getTodayClickCountsByPlatform,
  getUserNameEmail,
  getClickedUrls,
  getClickCountsByUrl,
  getBlockedUrls,
  getUserPendingPayments,
  recordAppVersion,
  getApk,
  getEffectivePlatformLimits,
  getUnrelatedUrls,
} from '@/lib/db'
import { loadVideosJson, retiredUrlSet } from '@/lib/videos'
import { HOURLY_LINK_LIMIT, HOURLY_WINDOW_MS, RETIRE_AFTER_USERS, SHOW_CLICKED_TODAY } from '@/lib/config'

export const dynamic = 'force-dynamic'

const KEYS = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram']

// GET — everything the app's Details panel shows: today's clicks per platform,
// pending pay, and per-platform available link counts + hourly-quota lock state.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Track the app version this user is running (reported via headers).
  const appVersionName = req.headers.get('x-app-version')
  const appVersionCodeRaw = Number(req.headers.get('x-app-version-code'))
  const appVersionCode = Number.isFinite(appVersionCodeRaw) && appVersionCodeRaw > 0 ? appVersionCodeRaw : null
  if (appVersionName || appVersionCode) {
    recordAppVersion(userId, appVersionName, appVersionCode).catch(() => {})
  }

  // Per-platform quota rules (admin-configurable); widen the click history to the
  // largest window so each platform can apply its own. A platform whose own
  // Enforce switch is off comes back unlimited (limit 0), so the app shows no
  // lock for it. The master switch is NOT consulted here — it governs retirement.
  const { limits, retirePlatforms } = await getEffectivePlatformLimits()
  const maxWindowMs = Math.max(HOURLY_WINDOW_MS, ...Object.values(limits).map((l) => l.windowMs || 0))
  const [times, today, info, clicked, clickCounts, videos, pending, blocked, apk, unrelated] = await Promise.all([
    getHourlyClickTimes(userId, maxWindowMs).catch(() => ({}) as Record<string, number[]>),
    getTodayClickCountsByPlatform(userId).catch(() => ({}) as Record<string, number>),
    getUserNameEmail(userId).catch(() => null),
    getClickedUrls(userId).catch(() => [] as string[]),
    getClickCountsByUrl().catch(() => ({}) as Record<string, number>),
    loadVideosJson(),
    getUserPendingPayments(userId).catch(() => null),
    getBlockedUrls().catch(() => [] as string[]),
    getApk().catch(() => null),
    getUnrelatedUrls(userId).catch(() => [] as string[]),
  ])

  // Available link counts per platform. Must withhold exactly what /api/app/links
  // withholds — clicked, retired, admin-blocked, and this user's unrelated flags —
  // or the app shows a count it can't actually serve. Retirement applies per
  // platform; the hourly quotas below are a separate switch.
  const retired = retiredUrlSet(videos, clickCounts, retirePlatforms)
  const hidden = new Set<string>(clicked)
  retired.forEach((u) => hidden.add(u))
  blocked.forEach((u) => hidden.add(u))
  unrelated.forEach((u) => hidden.add(u))
  const avail: Record<string, number> = {}
  for (const v of videos) {
    if (!v.url || !v.url.startsWith('http') || hidden.has(v.url)) continue
    const p = String(v.platform ?? '')
    avail[p] = (avail[p] ?? 0) + 1
  }

  const now = Date.now()
  const platforms: Record<
    string,
    { used: number; remaining: number; resetInMs: number; available: number; limit: number; windowMs: number }
  > = {}
  for (const p of KEYS) {
    const limit = limits[p]?.limit ?? HOURLY_LINK_LIMIT
    const windowMs = limits[p]?.windowMs ?? HOURLY_WINDOW_MS
    const unlimited = limit <= 0
    const arr = (times[p] ?? []).filter((t) => now - t < windowMs).sort((a, b) => a - b)
    const used = arr.length
    let resetInMs = 0
    if (!unlimited && used >= limit) {
      resetInMs = Math.max(0, arr[arr.length - limit] + windowMs - now)
    }
    platforms[p] = {
      used,
      remaining: unlimited ? Number.MAX_SAFE_INTEGER : Math.max(0, limit - used),
      resetInMs,
      available: avail[p] ?? 0,
      limit,
      windowMs,
    }
  }

  // Latest published APK — the app compares this versionName to its own (a higher
  // name like 1.1 > 1.0 triggers the self-update).
  const update =
    apk && apk.version && apk.url
      ? { versionName: apk.version, url: `${apk.url}?download=1` }
      : null

  return NextResponse.json({
    hourlyLimit: HOURLY_LINK_LIMIT,
    windowMs: HOURLY_WINDOW_MS,
    retireAfterUsers: RETIRE_AFTER_USERS,
    email: info?.email ?? '',
    today,
    pending,
    platforms,
    showClickedToday: SHOW_CLICKED_TODAY,
    update,
  })
}
