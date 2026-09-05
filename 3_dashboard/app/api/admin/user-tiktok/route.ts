import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getUserProfile,
  getTiktokAccounts,
  getFoundPresenceLinks,
  recordTiktokAccount,
  type TiktokAccountRow,
} from '@/lib/db'
import { handleFromProfile } from '@/lib/commentPresence'
import { fetchComments } from '@/lib/linkStats'
import { accountCreatedAt } from '@/lib/tiktokId'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// When was this user's TikTok account created?
//
// The answer is their numeric account id, which TikTok returns in exactly one
// place: the comment list. Presence checks now capture it as they judge, so for
// anyone scored recently this is a single row read and no network at all.
//
// This route exists for everyone else — users judged before the id was being
// kept. It re-reads links the ledger already says carry their comment, which is
// the cheapest possible lookup: those links are known to hold the answer.
//
// Bounded hard, because it runs while an admin waits on an expanded row.
const MAX_LINKS = 4
const BUDGET_MS = 25_000

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const userId = String(req.nextUrl.searchParams.get('userId') ?? '').trim()
  if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })

  const reply = (uid: string | null, source: string, note = '') => {
    const created = accountCreatedAt(uid)
    return NextResponse.json({
      uid,
      handle: null as string | null,
      createdAt: created ? created.toISOString() : null,
      source,
      note,
    })
  }

  try {
    const profile = await getUserProfile(userId).catch(() => null)
    const handle = handleFromProfile(profile?.tiktok_url ?? '')
    if (!handle) return reply(null, 'none', 'This user has no TikTok profile link.')

    // Already known — but only if it was learned from the handle they use now.
    const accounts = await getTiktokAccounts().catch(
      () => ({}) as Record<string, TiktokAccountRow>
    )
    const stored = accounts[userId]
    if (stored && stored.handle === handle) {
      const created = accountCreatedAt(stored.uid)
      return NextResponse.json({
        uid: stored.uid,
        handle,
        createdAt: created ? created.toISOString() : null,
        source: 'stored',
        note: created ? '' : 'The id is from before TikTok encoded a date in it.',
      })
    }

    const links = await getFoundPresenceLinks(userId, MAX_LINKS).catch(() => [] as string[])
    if (links.length === 0) {
      return reply(
        null,
        'no-comments',
        'No comment of theirs has been found yet, and the id only appears next to a comment. Run a presence check first.'
      )
    }

    const deadline = Date.now() + BUDGET_MS
    for (const url of links) {
      if (Date.now() >= deadline) break
      const read = await fetchComments(url, 4).catch(() => null)
      const hit = read?.comments.find((c) => c.username === handle && c.uid)
      if (!hit?.uid) continue
      await recordTiktokAccount(userId, handle, hit.uid).catch(() => {})
      const created = accountCreatedAt(hit.uid)
      return NextResponse.json({
        uid: hit.uid,
        handle,
        createdAt: created ? created.toISOString() : null,
        source: 'lookup',
        note: created ? '' : 'The id is from before TikTok encoded a date in it.',
      })
    }

    return reply(
      null,
      'not-found',
      'Their comment is no longer on the links it was found on — deleted, hidden, or past what TikTok will serve. The next presence check that finds one will pick the id up.'
    )
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
