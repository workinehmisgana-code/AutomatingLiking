import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getAdminGenre } from '@/lib/adminGenre'
import { isAdminEmail } from '@/lib/config'
import { mergeVerifyLinks } from '@/lib/verifyMerge'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { urls }    — merge these specific verify links into the main pool.
// POST { account } / { accounts: [] } — merge EVERY link those channels still
//   have in the verify list, across all pages. Judging whole channels at once
//   (from the bio and what they post) is faster and more consistent than judging
//   link by link.
//
// The work itself lives in lib/verifyMerge so the hourly channel harvest can do
// the same thing without impersonating an admin over HTTP.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  // TWO DIFFERENT REFUSALS, said differently. A bare "Forbidden" covered both
  // "this request carried no live sign-in" (a session that ended while the tab
  // stayed open — fixed by reloading) and "signed in, but not as the admin" —
  // and the admin could not tell which one they had hit.
  if (!session) {
    return NextResponse.json(
      {
        error:
          'Your sign-in was not recognised for this request (the session may have ended while ' +
          'the page was open). Reload the page — sign in again if asked — then merge again. ' +
          'Nothing was merged.',
        signedOut: true,
      },
      { status: 401 }
    )
  }
  if (!isAdminEmail(session.user.email)) {
    return NextResponse.json(
      { error: `Signed in as ${session.user.email}, which is not the admin account. Nothing was merged.` },
      { status: 403 }
    )
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'BLOB_READ_WRITE_TOKEN is not set on the server.' }, { status: 500 })
  }

  let urls: string[] = []
  let accounts: string[] = []
  try {
    const b = await req.json()
    urls = Array.isArray(b?.urls) ? b.urls.map((u: unknown) => String(u ?? '').trim()).filter(Boolean) : []
    // One channel or many; `account` is kept so older callers keep working.
    const many = Array.isArray(b?.accounts)
      ? b.accounts.map((a: unknown) => String(a ?? '').trim()).filter(Boolean)
      : []
    const one = String(b?.account ?? '').trim()
    accounts = many.length ? many : one ? [one] : []
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    return NextResponse.json(await mergeVerifyLinks({ urls, accounts, genre: await getAdminGenre() }))
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
