import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getBlockedUrls } from '@/lib/db'
import { loadVideosJson } from '@/lib/videos'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * The channel a link belongs to, from the URL itself.
 *
 * videos.json stores no account column, so the handle has to come from the URL.
 * TikTok and Instagram carry it directly; YouTube watch/shorts URLs carry only a
 * video id, so those links have no channel and are left out of the ratio rather
 * than lumped into a fake "unknown" bucket that would skew every percentage.
 */
function channelOf(url: string): string | null {
  const u = String(url || '')
  const tt = u.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i)
  if (tt) return tt[1].toLowerCase()
  const yt = u.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i)
  if (yt) return yt[1].toLowerCase()
  const ig = u.match(/instagram\.com\/([A-Za-z0-9._]+)\/(?:p|reel)\//i)
  if (ig) return ig[1].toLowerCase()
  return null
}

// GET — per-channel counts of ACTIVE (still in the pool, not blocked) versus
// BLOCKED links, so a channel's quality can be judged as one number instead of
// link by link. Computed live from videos.json + blocked_link; nothing is stored.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const [videos, blockedList] = await Promise.all([
      loadVideosJson().catch(() => []),
      getBlockedUrls().catch(() => [] as string[]),
    ])
    const blocked = new Set(blockedList)

    const stats: Record<string, { active: number; blocked: number }> = {}
    const bump = (ch: string | null, key: 'active' | 'blocked') => {
      if (!ch) return
      ;(stats[ch] ??= { active: 0, blocked: 0 })[key]++
    }

    // ACTIVE = in the pool and not blocked. A blocked URL often still sits in
    // videos.json, so it is skipped here and counted once in the pass below —
    // otherwise it would land in both buckets and inflate the channel's total.
    for (const v of videos) {
      const url = String((v as { url?: unknown }).url ?? '')
      if (!url || blocked.has(url)) continue
      bump(channelOf(url), 'active')
    }
    // BLOCKED counts every blocked URL exactly once, including ones no longer in
    // the pool: they were removed for a reason, and ignoring them would flatter
    // precisely the channels that have been cleaned up the most.
    for (const url of blockedList) {
      bump(channelOf(url), 'blocked')
    }

    return NextResponse.json({ stats, channels: Object.keys(stats).length })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
