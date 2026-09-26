import { NextResponse, type NextRequest } from 'next/server'
import { activeProductsForPlatform, pickFairProductForUrl } from '@/lib/db'
import { mimicComment, mentionsRival } from '@/lib/commentMimic'
import { COMPETITOR_BRANDS } from '@/lib/linkCategory'
import { isProduct, platformFromUrl } from '@/lib/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// A comment written to match one already under the video.
//
// The liker reads a video's comments, finds one recommending a rival tool, and
// posts it here; what comes back is a comment of ours in the same vein. When
// nothing usable comes back the liker falls back to /api/links/comment — the
// stored bank — which is why this returns an empty comment rather than an error
// for "the model gave me nothing I would post".
//
// Same token as the rest of the liker's endpoints: it runs from the operator's
// own accounts, has no app session, and there is no user to attribute to.
//
//   GET  /api/links/mimic?token=…        the rival names the liker looks for
//   POST /api/links/mimic?token=…        { url, sample, product? } → { comment }

function authed(req: NextRequest): boolean {
  const token = process.env.LINKS_EXPORT_TOKEN
  const provided =
    req.nextUrl.searchParams.get('token') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  return !!token && provided === token
}

// The brand list, so the liker does not keep a copy of its own. Two lists of
// rival names in two projects is one list that is wrong.
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ ok: true, brands: COMPETITOR_BRANDS })
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const url = String(body?.url ?? '').trim()
  const sample = String(body?.sample ?? '').trim()
  if (!url) return NextResponse.json({ error: 'url is required' }, { status: 400 })
  if (!sample) return NextResponse.json({ error: 'sample is required' }, { status: 400 })

  // Which product to advertise: the one asked for, or the same fair pick the
  // app and the stored-comment endpoint would make for this link, so switching
  // the mimic setting on does not quietly change which product gets promoted.
  const wanted = String(body?.product ?? '').trim()
  const platform = platformFromUrl(url)
  const active = await activeProductsForPlatform(platform).catch(() => [] as string[])
  if (!active.length) {
    return NextResponse.json({ error: 'No active products for this platform' }, { status: 409 })
  }
  const product =
    wanted && isProduct(wanted) && active.includes(wanted)
      ? wanted
      : await pickFairProductForUrl(url, active).catch(() => active[0])
  if (!product || !isProduct(product)) {
    return NextResponse.json({ error: 'No product to write for' }, { status: 409 })
  }

  // A model that returns nothing, times out, or fails to produce JSON is not an
  // error here: the liker's answer to all three is the same — post a stored
  // comment instead. Reported as an empty comment with a note, so the run says
  // why in its log rather than printing an HTTP 500 that means "try the bank".
  let comment = ''
  let note = ''
  try {
    comment = await mimicComment(product, sample)
  } catch (e) {
    note = String((e as Error)?.message ?? e).slice(0, 160)
  }
  try {
    return NextResponse.json({
      ok: true,
      // '' means "nothing I would post" — the liker falls back to the bank.
      comment,
      note,
      product,
      // Which rival the sample was recommending, when it names one. Only for
      // the liker's log: it is what makes a posted comment explainable later.
      rival: mentionsRival(sample),
      source: comment ? 'mimic' : 'none',
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
