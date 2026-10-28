import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { getAdminGenre } from '@/lib/adminGenre'
import { isAdminEmail } from '@/lib/config'
import { rankChannels } from '@/lib/channelRank'
import { mergeVerifyLinks } from '@/lib/verifyMerge'
import {
  cleanSpec,
  getAutoMergeSpec,
  saveAutoMergeSpec,
  specHasBounds,
  urlsMatchingSpecs,
} from '@/lib/autoMerge'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The auto-merge spec of the admin's genre (see lib/autoMerge.ts).
//
//   GET                  the spec; ?preview=1 adds how many staged links it covers now
//   PUT  { spec }        save it
//   POST                 merge what it covers now, without waiting for the harvest

async function admin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

/** What the saved spec covers right now, for the page to show beside it. */
async function preview(genre: string) {
  const spec = await getAutoMergeSpec(genre)
  // Previewed even while switched off, so the admin sees what turning it on does.
  if (!specHasBounds(spec)) return { spec, links: 0, channels: 0 }
  const ranked = await rankChannels()
  const m = await urlsMatchingSpecs(ranked, genre, { ignoreEnabled: true })
  return { spec, links: m.urls.length, channels: m.channels }
}

export async function GET(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const genre = await getAdminGenre()
    // The spec alone by default: counting what it covers ranks every channel,
    // which is too slow to do on each page open. ?preview=1 asks for the count.
    if (req.nextUrl.searchParams.get('preview') !== '1') {
      return NextResponse.json({ genre, spec: await getAutoMergeSpec(genre) })
    }
    return NextResponse.json({ genre, ...(await preview(genre)) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { spec?: unknown }
  const spec = cleanSpec(body.spec)
  if (spec.enabled && !specHasBounds(spec)) {
    return NextResponse.json(
      {
        error:
          'Set at least one filter before switching auto-merge on — a spec with no filters ' +
          'would merge every staged link of this genre.',
      },
      { status: 400 }
    )
  }
  try {
    const genre = await getAdminGenre()
    await saveAutoMergeSpec(genre, spec)
    return NextResponse.json({ ok: true, genre, ...(await preview(genre)) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'BLOB_READ_WRITE_TOKEN is not set on the server.' }, { status: 500 })
  }
  try {
    const genre = await getAdminGenre()
    const spec = await getAutoMergeSpec(genre)
    if (!spec.enabled || !specHasBounds(spec)) {
      return NextResponse.json({ error: 'Auto-merge is off for this genre — save a spec and switch it on first.' }, { status: 400 })
    }
    const m = await urlsMatchingSpecs(await rankChannels(), genre)
    if (m.urls.length === 0) {
      return NextResponse.json({ ok: true, added: 0, updated: 0, removed: 0, skippedBlocked: 0, channels: 0 })
    }
    const res = await mergeVerifyLinks({ urls: m.urls, genre })
    return NextResponse.json({ ok: true, ...res, channels: m.channels })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
