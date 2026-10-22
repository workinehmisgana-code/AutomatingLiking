import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getAdminGenre } from '@/lib/adminGenre'
import { DEFAULT_GENRE, isAdminEmail, isGenre } from '@/lib/config'
import { addExtraChannel, removeExtraChannel, getExtraChannels } from '@/lib/db'
import { fetchChannelVideos } from '@/lib/linkStats'
import {
  parseChannelInput,
  CHANNEL_SITES,
  HANDLE_RE,
  type ChannelSite,
} from '@/lib/channelInput'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Channels added by hand, so videos can be scraped from an account no link in
 * the pool names.
 *
 * Everything else the dashboard knows about channels is INFERRED from links it
 * already holds, which is a closed loop: a channel with no links is not in the
 * ranking, so the extract pass never visits it, so it never gets links. This is
 * the way in.
 *
 *   GET     list them
 *   POST    { input, site?, note? }   add one
 *   DELETE  ?site=&handle=            forget one
 */

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    // The switch's genre's hand-added channels only.
    const genre = await getAdminGenre()
    const all = await getExtraChannels()
    return NextResponse.json({ channels: all.filter((c) => (c.genre || DEFAULT_GENRE) === genre) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const body = (await req.json().catch(() => ({}))) as {
      input?: unknown
      site?: unknown
      note?: unknown
      genre?: unknown
    }
    const parsed = parseChannelInput(String(body.input ?? ''))
    // A URL names its own site and wins; the dropdown only settles a bare handle.
    const chosen = String(body.site ?? '').toLowerCase()
    const site = (parsed.site ??
      (CHANNEL_SITES.includes(chosen as ChannelSite) ? (chosen as ChannelSite) : null)) as
      | ChannelSite
      | null

    if (!parsed.handle) {
      return NextResponse.json(
        { error: 'Paste a channel profile link, or type the handle on its own.' },
        { status: 400 }
      )
    }
    if (!site) {
      return NextResponse.json(
        {
          error:
            'Which site is this channel on? Paste the profile link instead, or pick a site — ' +
            'the same handle exists on more than one, and guessing would send the scraper to ' +
            'a stranger.',
        },
        { status: 400 }
      )
    }
    if (!HANDLE_RE[site].test(parsed.handle)) {
      return NextResponse.json(
        { error: `"${parsed.handle}" is not a valid ${site} handle.` },
        { status: 400 }
      )
    }

    // Does it exist? TikTok is the one site whose listing this server can read,
    // so it is the one site where a typo can be caught before anybody waits for
    // an extraction that was never going to return anything.
    //
    // A miss does NOT block the add: the embed endpoint throttles, and a private
    // or brand-new account lists nothing while still being the channel that was
    // meant. The answer is reported and the admin decides.
    let listed: number | null = null
    if (site === 'tiktok') {
      listed = (await fetchChannelVideos(parsed.handle).catch(() => [])).length
    }

    // WHICH GENRE THIS CHANNEL IS FOR, typed once here rather than per video.
    // Everything extracted from it inherits this, and the merge files those
    // links in that genre's pool — so adding a cocodly channel is the whole of
    // telling the system that its videos are cocodly videos.
    const genre = isGenre(body.genre) ? body.genre : DEFAULT_GENRE
    const added = await addExtraChannel(site, parsed.handle, String(body.note ?? ''), genre)
    return NextResponse.json({
      ok: true,
      site,
      genre,
      handle: parsed.handle,
      // false means it was already on the list — worth saying, because "nothing
      // happened" and "added" look identical otherwise.
      added,
      listed,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const site = String(req.nextUrl.searchParams.get('site') ?? '')
    const handle = String(req.nextUrl.searchParams.get('handle') ?? '')
    if (!site || !handle) {
      return NextResponse.json({ error: 'Missing site or handle.' }, { status: 400 })
    }
    const removed = await removeExtraChannel(site, handle)
    return NextResponse.json({ ok: true, removed })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
