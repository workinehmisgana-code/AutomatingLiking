import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import {
  getClickedUrls,
  getClickCountsByUrl,
  getBlockedUrls,
  getConfirmedBrokenUrls,
  getServeOnlyClean,
  getUrlsWithProductComments,
  getCleanSessionClicks,
  getApk,
  getEffectivePlatformLimits,
  getUnrelatedUrls,
  isUserVerified,
  getLinkCategories,
  getLinkScans,
  getClusterDateShare,
  type LinkScanRow,
} from '@/lib/db'
import { loadVideosJson, retiredUrlSet, type RawVideo } from '@/lib/videos'
import { missingProducts } from '@/lib/commentScan'
import { clusterAndOrder } from '@/lib/cluster'
import { BROKEN_AFTER_MISSES } from '@/lib/linkStats'
import { mixOrderings, seedFrom, DEFAULT_DATE_SHARE } from '@/lib/clusterMix'
import {
  isAppOutdated,
  VERIFY_VIDEO_URL,
  VERIFY_GATE_ENABLED,
  APP_LINK_BATCH,
  FALLBACK_COMMENT_CATEGORY,
} from '@/lib/config'

export const dynamic = 'force-dynamic'

// Platform processing order when no filter is set: drain one platform before
// the next (the app switches when a platform's hourly quota is used up).
const PLATFORM_ORDER = ['tiktok', 'youtube_shorts', 'youtube_videos', 'instagram']

// Instagram links have no posted date, so they always cluster by search rank.
const RANK_ONLY_PLATFORMS = new Set(['instagram'])

// GET — the signed-in user's available links, same behavior as the web
// dashboard: already-opened + retired links removed; the rest ordered by
// clustering (search-rank clusters interleaved with posted-date clusters). With
// ?platform=X only that platform; otherwise platforms are grouped in order
// (all of one platform, then the next) so the app can finish one at a time.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Comment-verification gate — the app gets no links until the user has proved
  // they can comment from their registered account (see VerifyGate on the web).
  if (VERIFY_GATE_ENABLED && !(await isUserVerified(userId).catch(() => false))) {
    return NextResponse.json({
      verifyRequired: true,
      verifyUrl: VERIFY_VIDEO_URL,
      message:
        'Comment anything on the verification video from your registered TikTok account, then reopen the app.',
      count: 0,
      links: [],
    })
  }


  // Version gate: an app older than the latest published APK gets NO links — the
  // user must update first. (Compared by versionCode, falling back to versionName.)
  const appVersion = req.headers.get('x-app-version')
  const appCodeRaw = Number(req.headers.get('x-app-version-code'))
  const appCode = Number.isFinite(appCodeRaw) && appCodeRaw > 0 ? appCodeRaw : null
  const apk = await getApk().catch(() => null)
  if (apk && isAppOutdated(appVersion, appCode, apk.version, apk.versionCode)) {
    return NextResponse.json({
      count: 0,
      links: [],
      updateRequired: true,
      latestVersion: apk.version,
      update: apk.version && apk.url ? { versionName: apk.version, url: `${apk.url}?download=1` } : null,
      message: `Please update the app to v${apk.version ?? 'the latest version'} to keep getting links.`,
    })
  }

  // Retirement counts every distinct user who opened the link, across all
  // products — users aren't assigned to a product, so there is no per-product
  // audience to scope it to.
  const [clicked, clickCounts, videos, blocked, effective, unrelated, broken, onlyClean] =
    await Promise.all([
      getClickedUrls(userId).catch(() => [] as string[]),
      getClickCountsByUrl().catch(() => ({}) as Record<string, number>),
      loadVideosJson(),
      getBlockedUrls().catch(() => [] as string[]),
      getEffectivePlatformLimits(),
      getUnrelatedUrls(userId).catch(() => [] as string[]),
      // Links the platform no longer serves. Confirmed ones only — a single
      // dead reading is a suspicion, and withholding on it would let one bad
      // minute on TikTok's side shrink everyone's list.
      getConfirmedBrokenUrls(BROKEN_AFTER_MISSES).catch(() => [] as string[]),
      // Off by default; on, links already carrying one of ours are withheld.
      getServeOnlyClean().catch(() => false),
    ])
  // Read only when the setting is on: it is a full scan of link_product_comment
  // and pointless on every request when the answer is not used.
  const alreadyOurs = onlyClean
    ? await getUrlsWithProductComments().catch(() => [] as string[])
    : []
  // What this user has opened since the setting was switched on. It takes the
  // place of the permanent record while the setting is on — otherwise the same
  // link comes back on every fetch of the session.
  const sessionClicks = onlyClean
    ? await getCleanSessionClicks(userId).catch(() => [] as string[])
    : []
  // Withheld: clicked (already opened), retired (quota done), admin-blocked, and
  // links THIS user flagged as unrelated.
  //
  // The unrelated flag has to be honoured here or the button does the opposite of
  // what it says: flagging also deletes the user's click (so it stops counting
  // toward the quota), and without this filter the link is no longer "clicked"
  // and comes straight back into their list on the next fetch.
  //
  // Retirement applies per platform (hourly quotas are a separate switch).
  const retired = retiredUrlSet(videos, clickCounts, effective.retirePlatforms)
  // ALREADY-OPENED LINKS COME BACK when "only links with none of ours" is on.
  //
  // That setting only ever serves a link the extraction has NOT found one of
  // ours on. A link this user opened before and that still carries none of ours
  // is a link they opened without leaving a comment that stuck — so withholding
  // it is withholding exactly the work the setting exists to hand out. The
  // moment a comment does appear on it, the setting withholds it anyway.
  const hidden = new Set<string>(onlyClean ? sessionClicks : clicked)
  retired.forEach((u) => hidden.add(u))
  blocked.forEach((u) => hidden.add(u))
  unrelated.forEach((u) => hidden.add(u))
  broken.forEach((u) => hidden.add(u))
  alreadyOurs.forEach((u) => hidden.add(u))
  const platform = req.nextUrl.searchParams.get('platform')

  // How the two clusterings are mixed: a percentage set on the admin Links page
  // (default 75% posted-date, 25% search-rank). It used to be a five-minute
  // clock that handed everyone the same dimension at the same instant; now it is
  // a per-link draw, seeded by the user so two people working at the same second
  // get different blends while one person's own feed stays stable.
  const dateShare = await getClusterDateShare().catch(() => DEFAULT_DATE_SHARE)
  const seed = seedFrom(userId)

  const available = videos.filter((v) => v.url && v.url.startsWith('http') && !hidden.has(v.url))

  // Ordering WITHIN each clustering is the score and nothing else — search rank
  // in a rank cluster, date score in a date cluster. Neither what "Extract
  // comments" found on a link nor how many people have opened it has any say in
  // where it sits; clickCounts is still fetched above, but only for RETIREMENT.
  //
  // The two orderings are then blended at `dateShare`. A link never jumps ahead
  // of a better-scoring link from its own clustering; the only random thing is
  // which of the two the next link comes from.
  const mixed = (pool: RawVideo[]) =>
    mixOrderings(
      clusterAndOrder(pool, undefined, 'rank'),
      clusterAndOrder(pool, undefined, 'date'),
      dateShare,
      seed,
      APP_LINK_BATCH
    )
  const forPlatform = (p: string) => {
    const pool = available.filter((v) => String(v.platform ?? '') === p)
    // Instagram links carry no posted date, so there is no date ordering to
    // draw from — the share would silently do nothing there.
    return RANK_ONLY_PLATFORMS.has(p) ? clusterAndOrder(pool, undefined, 'rank') : mixed(pool)
  }

  // The feed is CAPPED (APP_LINK_BATCH). The app holds the batch on the device
  // and re-reads it on every tap, so handing it the whole pool is what makes the
  // bubble lag. The cap is well above what a session can consume, and each app
  // open fetches a fresh batch with already-clicked links filtered out.
  let ordered: RawVideo[]
  if (platform) {
    ordered = forPlatform(platform).slice(0, APP_LINK_BATCH)
  } else {
    // Split the budget evenly across platforms rather than truncating the tail:
    // a flat slice would spend the whole batch on the first platform and leave
    // the app with nothing to rotate to once that one hits its hourly quota.
    const share = Math.max(1, Math.ceil(APP_LINK_BATCH / (PLATFORM_ORDER.length + 1)))
    ordered = []
    for (const p of PLATFORM_ORDER) ordered.push(...forPlatform(p).slice(0, share))
    // Anything with an unrecognised platform goes last.
    const known = new Set(PLATFORM_ORDER)
    ordered.push(
      ...mixed(available.filter((v) => !known.has(String(v.platform ?? '')))).slice(0, share)
    )
    ordered = ordered.slice(0, APP_LINK_BATCH)
  }

  // Each link carries the audience it was categorised into, so the app copies a
  // comment written for that kind of video. Uncategorised links fall back to
  // FALLBACK_COMMENT_CATEGORY ('competitors') — the audience most of the pool
  // turned out to belong to, and the one whose comments assume least about a
  // video we never managed to read.
  const categories = await getLinkCategories().catch(() => ({}) as Record<string, string>)

  // What "Extract comments" found on each link — used ONLY to choose which
  // PRODUCT to serve on it, never to decide where the link sits in the queue.
  // Read for the batch being returned rather than the whole pool, since that is
  // all these fields are attached to.
  const scanRows = await getLinkScans(ordered.map((v) => String(v.url))).catch(
    () => ({}) as Record<string, LinkScanRow>
  )
  const links = ordered.map((v) => ({
    url: v.url,
    platform: v.platform ?? '',
    search_query: v.search_query ?? '',
    posted_date: v.posted_date ?? '',
    category: categories[String(v.url)] ?? FALLBACK_COMMENT_CATEGORY,
    // Products whose comment is ALREADY on this video, so the app can pick one
    // that is not — a video ending up with five variants of the same pitch helps
    // nobody. Empty when the link has not been scanned.
    hasProducts: scanRows[String(v.url)]?.products ?? [],
    // What to serve instead. Precomputed here so every client agrees.
    preferProducts: missingProducts(scanRows[String(v.url)]?.products ?? []),
  }))

  // `available` is what the user could still work through in total; `count` is
  // what this batch actually carries, so the app can tell "batch done, reopen"
  // apart from "genuinely out of links".
  return NextResponse.json({
    count: links.length,
    batchLimit: APP_LINK_BATCH,
    totalAvailable: available.length,
    links,
  })
}
