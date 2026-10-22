import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, validateTiktokProfile, canonicalTiktokProfile } from '@/lib/config'
import {
  getUserProfile,
  upsertUserProfile,
  releaseProfileLink,
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
// THE ADMIN REASSIGNS; A USER IS REFUSED. Self-service registration still rejects
// a link somebody else holds — two profiles on one TikTok account would let the
// same comments verify both. But an admin editing a link is usually fixing
// exactly that: the worker re-registered, or two accounts were crossed, and the
// person who can see both profiles is the one entitled to decide which is right.
//
// So here the link is TAKEN: whoever else held it loses it, their name is
// reported back, and nothing else about them changes. The uniqueness survives —
// one account, one worker — it is just the admin who says which worker.

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
  // An admin pasting a video URL here would put the account back in exactly the
  // state this editor exists to repair, so their input goes through the same
  // rule and is stored in the same shape. An EXISTING bad link is left as it
  // was when the admin is editing some other platform — the check below only
  // looks at what this request actually sent.
  const sentTiktok = 'tiktok_url' in body
  const next = {
    name: existing.name,
    bank_account: existing.bank_account,
    tiktok_url: sentTiktok
      ? canonicalTiktokProfile(clean(body.tiktok_url))?.url ?? clean(body.tiktok_url)
      : existing.tiktok_url,
    youtube_url: 'youtube_url' in body ? clean(body.youtube_url) : existing.youtube_url,
    instagram_url: 'instagram_url' in body ? clean(body.instagram_url) : existing.instagram_url,
  }

  const bad =
    (sentTiktok && next.tiktok_url !== null ? validateTiktokProfile(next.tiktok_url) : null) ||
    validate(next.youtube_url, /youtube\.com|youtu\.be/i, 'YouTube') ||
    validate(next.instagram_url, /instagram\.com/i, 'Instagram')
  if (bad) return NextResponse.json({ error: bad }, { status: 400 })

  try {
    // Taken from whoever held it, one platform at a time, before the write — the
    // unique index would otherwise reject the upsert regardless of what this
    // route decided.
    const takenFrom: { platform: string; userId: string; name: string | null }[] = []
    for (const [platform, url] of [
      ['tiktok', next.tiktok_url],
      ['youtube', next.youtube_url],
      ['instagram', next.instagram_url],
    ] as const) {
      const lost = await releaseProfileLink(platform, url, userId)
      for (const l of lost) takenFrom.push({ platform, ...l })
    }
    // phone/telegram are not part of this editor: an admin fixes links here,
    // and the upsert COALESCEs null so the person's contact details survive it.
    await upsertUserProfile(userId, { ...next, phone: null, telegram: null, bank_name: null })
    return NextResponse.json({ ok: true, profile: next, takenFrom })
  } catch (e) {
    if (e instanceof ProfileLinkConflictError) {
      // Only reachable if somebody registered the same link in the moment
      // between the release above and this write.
      return NextResponse.json(
        {
          error:
            `Somebody registered that ${e.platforms.join(', ')} link a moment ago. ` +
            'Try again.',
        },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: `Could not save: ${String(e)}` }, { status: 500 })
  }
}
