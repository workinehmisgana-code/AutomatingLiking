import { NextResponse, type NextRequest } from 'next/server'
import { fetchComments } from '@/lib/linkStats'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Is a comment we posted still on the video — as everybody else sees it?
//
// THE SAME READ THE ADMIN USES to check a worker's comment (lib/commentPresence
// judge()): one plain request to TikTok's comment list from this server, with no
// session and nobody signed in. That matters twice over.
//
//   IT WORKS FROM HERE. The liker's own machine gets one to four comments out
//   of a video with hundreds — throttled — and a check that reads four comments
//   reports everything as removed. This server reads ~50 a link.
//
//   IT IS THE PUBLIC VIEW. A comment read from the account that wrote it proves
//   only that its author can see it; TikTok shows a filtered comment to its
//   author and to nobody else. What matters is whether the rest of the world
//   can see it, and that is what this answers.
//
// The judging rule is the admin's, for the same reason it exists there: a HIT is
// conclusive on a partial read — we saw it — while a MISS only counts when the
// whole comment section was readable. Anything else is "could not tell", which
// is not the same as gone and must not be counted as though it were.
//
//   POST /api/links/comment-check?token=…
//     { "items": [ { "url": "...", "text": "the comment we posted" }, ... ] }
//   → { results: [ { url, found, judgeable, readCount, total, username } ] }

const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

export async function POST(req: NextRequest) {
  const token = process.env.LINKS_EXPORT_TOKEN
  const provided =
    req.nextUrl.searchParams.get('token') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token || provided !== token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { items?: { url?: unknown; text?: unknown }[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const items = (Array.isArray(body?.items) ? body.items : [])
    .map((i) => ({ url: String(i?.url ?? '').trim(), text: String(i?.text ?? '').trim() }))
    .filter((i) => i.url && i.text)
    // Bounded by the 60s this function gets: a read is a network round trip and
    // a caller with two hundred comments should send them in batches rather
    // than have the whole request time out with nothing to show.
    .slice(0, 25)
  if (!items.length) {
    return NextResponse.json({ error: 'items must be [{url, text}]' }, { status: 400 })
  }

  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const read = await fetchComments(item.url, 4)
        const needle = norm(item.text).slice(0, 40)
        const hit = read.unresolved
          ? undefined
          : read.comments.find((c) => needle && norm(c.text).includes(needle))
        const found = hit !== undefined
        // A READ THAT CAME BACK ALMOST EMPTY TELLS US NOTHING, and it will
        // happily call itself complete. Measured on a video with hundreds of
        // comments, from a throttled address: readCount 1, total 1, complete
        // true — which the admin's rule would take as "the whole section was
        // readable and our comment is not in it", and report a live comment as
        // deleted. TikTok's own total is throttled along with the list, so it
        // cannot be the thing that catches this.
        //
        // A HIT IS CONCLUSIVE. A MISS IS NOT — not from here, and no arithmetic
        // on this response makes it one.
        //
        // Three rules were tried against real videos and all three were wrong:
        //   "complete"        a 4-comment read called itself complete on a video
        //                     whose page said 8, and reported a live comment gone.
        //   "read >= 10"      these are the freshest links in the pool; their
        //                     pages say 1, 8, 5, 3. Nothing would ever be judged.
        //   "read >= total"   TikTok's own total is throttled with the list. It
        //                     answered "1 of 1" for a video showing 2 comments,
        //                     one of which was ours.
        //
        // So this reports what it saw and leaves the verdict to the caller, who
        // has a second source: the authoring account's own browser. Found here
        // means the public can see it; missing here means only that this read
        // did not see it.
        // `thin` is "this read is not evidence of absence". It cannot be
        // computed from TikTok's own numbers, because they are throttled along
        // with the list: it answered "1 of 1" for a video whose comment panel
        // showed two, one of which was ours. Read >= total looked principled
        // and passed exactly the reads it should have rejected.
        //
        // What is left is the count itself. A read in single figures is a limit
        // on this address, not a comment section; the deployed dashboard reads
        // about fifty a link, and there the flag means what it says.
        const thin = read.comments.length < 10
        return {
          url: item.url,
          found,
          // A miss on a partial read is not a miss. Same rule as the admin's,
          // plus the coverage test above.
          judgeable: found || (!read.unresolved && read.complete && !thin),
          thin,
          readCount: read.comments.length,
          total: read.total,
          username: hit?.username ?? null,
        }
      } catch (e) {
        return {
          url: item.url,
          found: false,
          judgeable: false,
          thin: true,
          readCount: 0,
          total: null,
          username: null,
          error: String(e).slice(0, 120),
        }
      }
    })
  )

  return NextResponse.json({ ok: true, results })
}
