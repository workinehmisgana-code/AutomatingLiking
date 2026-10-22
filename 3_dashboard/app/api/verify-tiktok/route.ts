import { NextResponse } from 'next/server'
import { VERIFY_MIN_AGE_DAYS } from '@/lib/config'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import {
  getUserProfile,
  getTiktokVerification,
  saveTiktokVerification,
  getVerifyVideoUrl,
  getMinAccountAgeDays,
} from '@/lib/db'
import { runTiktokCheck } from '@/lib/tiktokVerify'
import { verifiedNow } from '@/lib/profileGate'

export const dynamic = 'force-dynamic'
// The check reads several pages of a TikTok comment list, which took 8.5s on a
// busy video. The default 10s would abort a legitimate read.
export const maxDuration = 60

// Proving a worker owns the TikTok account they registered, and that it is at
// least three months old.
//
//   GET   what they have to do, and where they stand
//   POST  look for their comment now and decide
//
// A worker runs this themselves, as often as they like: the expensive thing is
// TikTok's patience, not ours, and a check that cannot be retried turns a
// mistyped comment into a support request.

async function me(): Promise<{ id: string; name: string } | null> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  const id = session?.user?.id
  if (!id) return null
  return { id, name: session.user?.name ?? '' }
}

export async function GET() {
  const user = await me()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const [profile, saved, videoUrl, minAgeDays] = await Promise.all([
    getUserProfile(user.id).catch(() => null),
    getTiktokVerification(user.id).catch(() => null),
    getVerifyVideoUrl().catch(() => ''),
    getMinAccountAgeDays().catch(() => VERIFY_MIN_AGE_DAYS),
  ])
  // Judged against TODAY's minimum (see verifiedNow): an account that passed
  // under a lower setting reads as too new until it is old enough, and one that
  // was too new reads as passed once it is.
  const verified = saved ? verifiedNow(saved, minAgeDays) : false
  const status = !saved
    ? null
    : verified
      ? 'ok'
      : saved.status === 'ok'
        ? 'too_new'
        : saved.status
  const ageDays = saved?.accountAt
    ? Math.floor((Date.now() - Date.parse(saved.accountAt)) / 86_400_000)
    : (saved?.ageDays ?? null)
  return NextResponse.json({
    ok: true,
    videoUrl,
    minAgeDays,
    // The name to comment: whatever we would recognise them by.
    name: profile?.name || user.name || '',
    tiktokUrl: profile?.tiktok_url || '',
    status,
    verified,
    accountAt: saved?.accountAt ?? null,
    ageDays,
    checkedAt: saved?.checkedAt ?? null,
  })
}

export async function POST() {
  const user = await me()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [profile, videoUrl, minAgeDays] = await Promise.all([
    getUserProfile(user.id).catch(() => null),
    getVerifyVideoUrl().catch(() => ''),
    getMinAccountAgeDays().catch(() => VERIFY_MIN_AGE_DAYS),
  ])
  const result = await runTiktokCheck({
    profile: profile?.tiktok_url ?? '',
    videoUrl,
    minAgeDays,
  })

  // ONLY A DECISION IS WORTH STORING. 'not_found' and 'unreadable' are "ask
  // again in a minute", and writing them would turn a slow TikTok into a
  // recorded verdict that an admin later reads as a judgement on the worker.
  if (result.status !== 'not_found' && result.status !== 'unreadable') {
    await saveTiktokVerification(user.id, {
      handle: result.handle,
      status: result.status,
      uid: result.uid,
      accountAt: result.createdAt,
      ageDays: result.ageDays,
      commentText: result.text,
      videoUrl,
    }).catch(() => {})
  }

  return NextResponse.json({
    ok: true,
    verified: result.status === 'ok',
    status: result.status,
    message: result.message,
    ageDays: result.ageDays,
    accountAt: result.createdAt?.toISOString() ?? null,
    handle: result.handle,
    // How much of the list we saw, so "not found" can be explained rather than
    // just asserted.
    read: result.read,
    total: result.total,
    complete: result.complete,
    videoUrl,
  })
}
