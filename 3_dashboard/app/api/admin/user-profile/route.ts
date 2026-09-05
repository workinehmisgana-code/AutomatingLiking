import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getUserProfile,
  upsertUserProfile,
  findProfileLinkConflicts,
  ProfileLinkConflictError,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

// PATCH { userId, tiktok_url?, youtube_url?, instagram_url? } — change a user's
// profile links from the admin dashboard.
//
// Users register these themselves, but they mistype them, move accounts, or get
// their handle changed — and every check that matters (comment verification,
// presence scoring) keys off tiktok_url, so a wrong one makes an honest worker
// look like they never commented.
//
// Reuses the same uniqueness rule as self-service registration: a link already
// registered by ANOTHER user is refused, because two profiles pointing at one
// account would let the same comments verify both.

/** Trim to null; an empty box means "no link", not the string "". */
function clean(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return s === '' ? null : s
}

/** Reject anything that isn't a plausible profile URL for that platform. */
function validate(url: string | null, host: RegExp, label: string): string | null {
  if (url === null) return null
  if (!/^https?:\/\//i.test(url)) return `${label} link must start with http:// or https://`
  if (!host.test(url)) return `${label} link must be a ${label} URL`
  return null
}

export async function PATCH(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const userId = String(body.userId ?? '').trim()
  if (!userId) return NextResponse.json({ error: 'Missing userId' }, { status: 400 })

  const existing = await getUserProfile(userId).catch(() => null)
  if (!existing) {
    return NextResponse.json(
      { error: 'This user has no profile yet — they must register before their links can be edited.' },
      { status: 404 }
    )
  }

  // Only the keys actually sent are changed; anything omitted keeps its value.
  // name and bank_account are never touched here — upsertUserProfile needs them,
  // so they are carried through from the stored row.
  const next = {
    name: existing.name,
    bank_account: existing.bank_account,
    tiktok_url: 'tiktok_url' in body ? clean(body.tiktok_url) : existing.tiktok_url,
    youtube_url: 'youtube_url' in body ? clean(body.youtube_url) : existing.youtube_url,
    instagram_url: 'instagram_url' in body ? clean(body.instagram_url) : existing.instagram_url,
  }

  const bad =
    validate(next.tiktok_url, /tiktok\.com/i, 'TikTok') ||
    validate(next.youtube_url, /youtube\.com|youtu\.be/i, 'YouTube') ||
    validate(next.instagram_url, /instagram\.com/i, 'Instagram')
  if (bad) return NextResponse.json({ error: bad }, { status: 400 })

  try {
    const conflicts = await findProfileLinkConflicts(userId, next)
    if (conflicts.length > 0) {
      return NextResponse.json(
        { error: `Already registered by another user: ${conflicts.join(', ')}` },
        { status: 409 }
      )
    }
    await upsertUserProfile(userId, next)
    return NextResponse.json({ ok: true, profile: next })
  } catch (e) {
    if (e instanceof ProfileLinkConflictError) {
      return NextResponse.json(
        { error: `Already registered by another user: ${e.platforms.join(', ')}` },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: `Could not save: ${String(e)}` }, { status: 500 })
  }
}
