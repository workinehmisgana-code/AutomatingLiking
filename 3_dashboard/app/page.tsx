import { list } from '@vercel/blob'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Dashboard from '@/components/Dashboard'
import Login from '@/components/Login'
import Blocked from '@/components/Blocked'
import BlockedRemediation from '@/components/BlockedRemediation'
import VerifyGate from '@/components/VerifyGate'
// The age-aware, permanent verdict. A different thing from isUserVerified,
// which is the rolling presence check that expires. See lib/profileGate.
import { isTiktokVerified } from '@/lib/profileGate'
import BankNameGate from '@/components/BankNameGate'
import ContactGate from '@/components/ContactGate'
import TiktokGate from '@/components/TiktokGate'
import type { Video } from '@/components/Dashboard'
import { auth } from '@/lib/auth'
import {
  getClickedUrls,
  getClickCountsByUrl,
  getTodayClickCountsByPlatform,
  getHourlyClickTimes,
  getUserProfile,
  isProfileComplete,
  needsContactOnly,
  needsBankNameOnly,
  needsTiktokProfileFix,
  recordLoginDay,
  hasAnyLoginDay,
  getUnreadMessages,
  getUserPendingPayments,
  consumePayNotice,
  getApk,
  getBlockedPoolUrls,
  getBlockForEmail,
  getEffectivePlatformLimits,
  isUserVerified,
  getUserValidity,
  getTiktokVerification,
  getVerifyVideoUrl,
  getClusterDateShare,
  getConfirmedBrokenUrls,
  getServeOnlyClean,
  getUrlsWithProductComments,
  getCleanSessionClicks,
  getLinkCategoriesFor,
  assignReferralCode,
  getReferralEarnings,
  getReferralOf,
  getGenreMix,
  getUserPausedGenres,
} from '@/lib/db'
import { retiredUrlSet } from '@/lib/videos'
import { buildUserFeed, FEED_PER_PLATFORM } from '@/lib/userFeed'
import { BROKEN_AFTER_MISSES } from '@/lib/linkStats'
import { DEFAULT_DATE_SHARE } from '@/lib/clusterMix'
import {
  genreWeights,
  withoutGenres,
  isAdminEmail,
  SHOW_CLICKED_TODAY,
  SHOW_OTHER_TASKS,
  VERIFY_VIDEO_URL,
  VERIFY_GATE_ENABLED,
  repairRowPlatform,
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
    const data = await res.json()
    return Array.isArray(data) ? (data as Video[]).map(repairRowPlatform) : []
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
        videoUrl={await getVerifyVideoUrl().catch(() => '')}
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
  // SOMEBODY WHO ALREADY REGISTERED IS NOT A NEW USER. The phone number and
  // Telegram username were added after these accounts existed, so a worker of
  // several weeks is suddenly "incomplete" — and dropping them into a form
  // asking for their bank account again reads as having been reset. They get
  // the reason and a button instead; a first-time visitor still goes straight
  // to the form, because there is nothing to explain yet.
  if (needsContactOnly(profile)) {
    return <ContactGate name={profile?.name ?? session.user.name ?? null} />
  }
  // The bank name was asked for after these accounts existed, the same way.
  if (needsBankNameOnly(profile)) {
    return <BankNameGate name={profile?.name ?? session.user.name ?? null} />
  }
  if (!isProfileComplete(profile)) redirect('/onboarding')

  // A LINK THAT DOES NOT NAME AN ACCOUNT STOPS HERE, and it has to stop before
  // the verification gate below: that gate reads the @username out of
  // tiktok_url and looks for it among a video's commenters, so with no username
  // to find it can only ever answer "not verified". The person would sit behind
  // a check that cannot pass, being told to go and comment, with nothing on
  // screen to suggest the problem is a link they pasted months ago.
  if (needsTiktokProfileFix(profile)) {
    return (
      <TiktokGate
        name={profile?.name ?? session.user.name ?? null}
        current={profile?.tiktok_url ?? null}
      />
    )
  }

  // Comment-verification gate: until a check finds this user's comment on the
  // verification video, hold them here instead of serving links. Checked after
  // onboarding so a new user completes their profile (and TikTok link) first —
  // the gate needs that handle to have something to look for.
  //
  // IT NOW ALSO CHECKS HOW OLD THE ACCOUNT IS. The comment proves they own the
  // account; the numeric id carried on that same comment dates it (see
  // lib/tiktokVerify). An account younger than three months is refused — a
  // brand-new account's comments are the first TikTok filters away — so one
  // comment answers both questions in a single pass.
  //
  // isTiktokVerified, not isUserVerified: the latter is the SEPARATE rolling
  // presence check that expires every VERIFY_VALID_DAYS. This verdict is
  // permanent and tied to the handle, so it is asked once and re-asked only
  // when the worker points their profile at a different account.
  if (VERIFY_GATE_ENABLED && !(await isTiktokVerified(session.user.id).catch(() => false))) {
    const checkedAt =
      (await getTiktokVerification(session.user.id).catch(() => null))?.checkedAt ?? null
    // The STORED video, not the compiled constant: the admin can rotate it
    // when a video's comment list gets too deep to read, and the gate and the
    // check have to be looking at the same one.
    const verifyVideo = await getVerifyVideoUrl().catch(() => VERIFY_VIDEO_URL)
    return (
      <VerifyGate
        videoUrl={verifyVideo}
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

  const [allVideos, clickedUrls, clickCounts, todayCounts, hourly, messages, pending, paidNotice, apk, blockedUrls, brokenUrls, onlyClean] =
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
      getBlockedPoolUrls().catch(() => [] as string[]),
      // Links the platform no longer serves, confirmed over two passes.
      getConfirmedBrokenUrls(BROKEN_AFTER_MISSES).catch(() => [] as string[]),
      // Off by default; on, links already carrying one of ours are withheld.
      getServeOnlyClean().catch(() => false),
    ])
  // Read only when the setting is on — a full scan of link_product_comment is
  // not worth doing on every page load for an answer nobody uses.
  const alreadyOurs = onlyClean
    ? await getUrlsWithProductComments().catch(() => [] as string[])
    : []
  // What share of workers the admin has put on the posted-date clustering.
  const dateShare = await getClusterDateShare().catch(() => DEFAULT_DATE_SHARE)

  // Referrals. assignReferralCode is idempotent and returns the existing code
  // untouched, so calling it here is what gives EVERY user a code — including
  // the ones who registered before referrals existed and will never open the
  // onboarding form again.
  await assignReferralCode(session.user.id, profile?.name ?? '', session.user.email ?? '').catch(
    () => null
  )
  const [referrals, referredBy] = await Promise.all([
    getReferralEarnings(session.user.id).catch(() => null),
    getReferralOf(session.user.id).catch(() => null),
  ])
  // Permanently-blocked links never appear, even if a new videos.json re-adds them.
  // Blocked (a judgement we made) and broken (the platform no longer serves it)
  // are different facts with the same effect here: neither is worth anyone's
  // time to open.
  const goneSet = new Set([...blockedUrls, ...brokenUrls, ...alreadyOurs])
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
  //
  // ALREADY-OPENED LINKS COME BACK when "only links with none of ours" is on:
  // that setting only serves links carrying none of ours, so one this user
  // opened before and that still carries none is a link they opened without
  // leaving a comment that stuck. Withholding it withholds the very work the
  // setting exists to hand out. Passed on to Dashboard as an empty clicked
  // list too, or its own filter would take them straight back out — and its
  // remaining counts would be short by the same links.
  const sessionClicks = onlyClean
    ? await getCleanSessionClicks(session.user.id).catch(() => [] as string[])
    : []
  const alreadyOpened = onlyClean ? sessionClicks : clickedUrls
  // How much of this worker's list each genre gets. Read here rather than
  // inside buildUserFeed so the feed stays a pure function of what it is given.
  // MINUS THIS WORKER'S PAUSED GENRES: the comment check found too few of their
  // comments on those links while another genre's were fine (noCommentVerdict),
  // so the other genres fill their list instead.
  const genreMix = withoutGenres(
    genreWeights(await getGenreMix().catch(() => null)),
    await getUserPausedGenres(session.user.id).catch(() => [])
  )
  const { served, remaining } = buildUserFeed(
    videos,
    new Set([...alreadyOpened, ...retiredUrls]),
    FEED_PER_PLATFORM,
    genreMix
  )

  // The audience each served link was sorted into, so the page copies a comment
  // written for that kind of video. Read for the SLICE, not the pool: the whole
  // link_category table is 150k rows to answer a question about four hundred
  // links. A link with no row keeps no category and the page falls back to
  // FALLBACK_COMMENT_CATEGORY when it picks.
  const feedCategories = await getLinkCategoriesFor(served.map((v) => String(v.url))).catch(
    () => ({}) as Record<string, string>
  )
  const withCategory = served.map((v) => ({
    ...v,
    category: feedCategories[String(v.url)] ?? null,
  }))

  return (
    <Dashboard
      videos={withCategory}
      remainingByPlatform={remaining}
      clickedUrls={alreadyOpened}
      retiredUrls={retiredUrls}
      dateShare={dateShare}
      todayCounts={todayCounts}
      hourly={hourly}
      firstLogin={firstLogin}
      messages={messages}
      pendingPay={pending}
      referrals={referrals}
      referredBy={referredBy}
      paidNotice={paidNotice}
      apk={apk}
      showClickedToday={SHOW_CLICKED_TODAY}
      showOtherTasks={SHOW_OTHER_TASKS}
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
