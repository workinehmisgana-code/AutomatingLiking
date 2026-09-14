import { list } from '@vercel/blob'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Dashboard from '@/components/Dashboard'
import Login from '@/components/Login'
import Blocked from '@/components/Blocked'
import BlockedRemediation from '@/components/BlockedRemediation'
import VerifyGate from '@/components/VerifyGate'
import type { Video } from '@/components/Dashboard'
import { auth } from '@/lib/auth'
import {
  getClickedUrls,
  getClickCountsByUrl,
  getTodayClickCountsByPlatform,
  getHourlyClickTimes,
  getUserProfile,
  isProfileComplete,
  recordLoginDay,
  hasAnyLoginDay,
  getUnreadMessages,
  getUserPendingPayments,
  consumePayNotice,
  getApk,
  getBlockedUrls,
  getBlockForEmail,
  getEffectivePlatformLimits,
  isUserVerified,
  getUserValidity,
  getClusterDateShare,
  getConfirmedBrokenUrls,
} from '@/lib/db'
import { retiredUrlSet } from '@/lib/videos'
import { buildUserFeed, FEED_PER_PLATFORM } from '@/lib/userFeed'
import { BROKEN_AFTER_MISSES } from '@/lib/linkStats'
import { DEFAULT_DATE_SHARE } from '@/lib/clusterMix'
import {
  isAdminEmail,
  SHOW_CLICKED_TODAY,
  VERIFY_VIDEO_URL,
  VERIFY_GATE_ENABLED,
} from '@/lib/config'

export const dynamic = 'force-dynamic'

async function getVideos(): Promise<Video[]> {
  try {
    const { blobs } = await list({ prefix: 'videos.json' })
    if (!blobs.length) return []
    const res = await fetch(blobs[0].url, {
      headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      cache: 'no-store',
    })
    if (!res.ok) return []
    return res.json()
  } catch {
    return []
  }
}

function ServiceError({ detail }: { detail: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <p className="text-4xl mb-4">🔌</p>
        <p className="text-lg font-medium text-zinc-300">Server not configured</p>
        <p className="text-sm text-zinc-500 mt-2">
          Sign-in failed to initialize. Check that{' '}
          <code className="bg-zinc-800 px-1 py-0.5 rounded">BETTER_AUTH_SECRET</code> and{' '}
          <code className="bg-zinc-800 px-1 py-0.5 rounded">DATABASE_URL</code> are set in the
          environment (in Vercel&apos;s env vars for production), and that the database is reachable.
        </p>
        <p className="text-xs text-zinc-600 mt-3 break-all">{detail}</p>
      </div>
    </div>
  )
}

export default async function Home() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch (e) {
    return <ServiceError detail={e instanceof Error ? e.message : String(e)} />
  }
  if (!session) return <Login />

  // The admin sees the admin dashboard instead of the normal one.
  if (isAdminEmail(session.user.email)) redirect('/admin')

  // Blocked users can't use the dashboard. A 'forever' block is a dead end; the
  // correctable reasons ('bank'/'tiktok') show a form to enter a new value.
  const block = await getBlockForEmail(session.user.email).catch(() => null)
  if (block) {
    if (block.reason === 'forever') return <Blocked email={session.user.email ?? ''} />
    return (
      <BlockedRemediation
        reason={block.reason}
        email={session.user.email ?? ''}
        auto={block.auto}
      />
    )
  }

  // Is this the user's very first login? (Check before recording today's day.)
  const firstLogin = await hasAnyLoginDay(session.user.id)
    .then((seen) => !seen)
    .catch(() => false)
  // Track that this user was active today (for the admin's "login days").
  await recordLoginDay(session.user.id).catch(() => {})

  // First login (incomplete profile) → onboarding. There is no product to choose:
  // users aren't assigned to one, they work for every product.
  const profile = await getUserProfile(session.user.id).catch(() => null)
  if (!isProfileComplete(profile)) redirect('/onboarding')

  // Comment-verification gate: until a check finds this user's comment on the
  // verification video, hold them here instead of serving links. Checked after
  // onboarding so a new user completes their profile (and TikTok link) first —
  // the gate needs that handle to have something to look for.
  if (VERIFY_GATE_ENABLED && !(await isUserVerified(session.user.id).catch(() => false))) {
    const { checkedAt } = await getUserValidity(session.user.id).catch(() => ({
      validUntil: null,
      checkedAt: null,
    }))
    return (
      <VerifyGate
        videoUrl={VERIFY_VIDEO_URL}
        tiktokUrl={profile?.tiktok_url ?? null}
        checkedAt={checkedAt}
        email={session.user.email ?? ''}
      />
    )
  }

  // Per-platform link quota + wait window (admin-configurable). A platform is
  // enforced only when the master switch AND that platform's own switch are on;
  // every other platform comes back unlimited (limit 0) so it never locks.
  const { limits: platformLimits, retirePlatforms } = await getEffectivePlatformLimits()
  const maxWindowMs = Math.max(
    60 * 60 * 1000,
    ...Object.values(platformLimits).map((l) => l.windowMs || 0)
  )

  const [allVideos, clickedUrls, clickCounts, todayCounts, hourly, messages, pending, paidNotice, apk, blockedUrls, brokenUrls] =
    await Promise.all([
      getVideos(),
      getClickedUrls(session.user.id).catch(() => [] as string[]),
      // Retirement counts every distinct user who opened the link, across all
      // products — with no per-user product there is no per-product audience.
      getClickCountsByUrl().catch(() => ({}) as Record<string, number>),
      getTodayClickCountsByPlatform(session.user.id).catch(() => ({}) as Record<string, number>),
      getHourlyClickTimes(session.user.id, maxWindowMs).catch(() => ({}) as Record<string, number[]>),
      getUnreadMessages(session.user.id).catch(() => []),
      getUserPendingPayments(session.user.id).catch(() => null),
      // Shown exactly once, on the first load after the admin marked them paid.
      consumePayNotice(session.user.id).catch(() => null),
      getApk().catch(() => null),
      getBlockedUrls().catch(() => [] as string[]),
      // Links the platform no longer serves, confirmed over two passes.
      getConfirmedBrokenUrls(BROKEN_AFTER_MISSES).catch(() => [] as string[]),
    ])
  // What share of workers the admin has put on the posted-date clustering.
  const dateShare = await getClusterDateShare().catch(() => DEFAULT_DATE_SHARE)
  // Permanently-blocked links never appear, even if a new videos.json re-adds them.
  // Blocked (a judgement we made) and broken (the platform no longer serves it)
  // are different facts with the same effect here: neither is worth anyone's
  // time to open.
  const goneSet = new Set([...blockedUrls, ...brokenUrls])
  const videos = allVideos.filter((v) => !goneSet.has(String((v as { url?: unknown }).url ?? '')))
  // Retire links per their engagement-based quota (TikTok likes/10, YT views/100,
  // Instagram = the cap) — hidden from every user once they hit it. Retirement only
  // applies while quota enforcement is ON; with it OFF no link is ever retired.
  // Retirement applies per platform (master switch AND that platform's own
  // retirement switch) — independent of the hourly quotas.
  const retiredUrls = Array.from(retiredUrlSet(videos, clickCounts, retirePlatforms))

  // Only this user's slice crosses the wire. The whole pool used to: 129k links,
  // tens of megabytes, re-sent on every load so a phone could render the first
  // twenty. Each link keeps the cluster and position it earned against the FULL
  // pool, so the queue means the same thing it always did — see lib/userFeed.
  // Links already opened, and retired ones, are dropped before the cut, so the
  // cap is a hundred links per platform that can actually be worked on.
  const { served, remaining } = buildUserFeed(
    videos,
    new Set([...clickedUrls, ...retiredUrls]),
    FEED_PER_PLATFORM
  )

  return (
    <Dashboard
      videos={served}
      remainingByPlatform={remaining}
      clickedUrls={clickedUrls}
      retiredUrls={retiredUrls}
      dateShare={dateShare}
      todayCounts={todayCounts}
      hourly={hourly}
      firstLogin={firstLogin}
      messages={messages}
      pendingPay={pending}
      paidNotice={paidNotice}
      apk={apk}
      showClickedToday={SHOW_CLICKED_TODAY}
      user={{
        name: session.user.name ?? '',
        email: session.user.email ?? '',
        image: session.user.image ?? null,
      }}
      profile={profile}
      product={null}
      limits={platformLimits}
    />
  )
}
