import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { CLASSIFY_MAX_ITEMS, isAdminEmail } from '@/lib/config'
import { classifyRelatedByGenre, type Item } from '@/lib/titleClassify'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { items: [{ url, title }] } — returns { related: [url,...] } for the titles
// the model judges to be about AI humanizers / AI detectors.
//
// The rules live in lib/titleClassify so the hourly channel harvest applies the
// same ones without going through this endpoint.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  // EACH ITEM CARRIES ITS OWN GENRE. The staging list can hold several at once,
  // and "is this title related" is a different question per genre — asking one
  // of them about all the links marks the other genres' links unrelated, which
  // is exactly what happened when the question was humanizer-only.
  let items: (Item & { genre?: string })[] = []
  try {
    const b = await req.json()
    if (Array.isArray(b?.items)) {
      items = b.items
        .map((it: unknown) => {
          const o = it as { url?: unknown; title?: unknown; genre?: unknown }
          return {
            url: String(o?.url ?? '').trim(),
            title: String(o?.title ?? '').trim(),
            genre: String(o?.genre ?? '').trim(),
          }
        })
        .filter((it: Item) => it.url && it.title)
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (items.length === 0) return NextResponse.json({ related: [] })
  // NOT TRIMMED. This used to `.slice(0, 120)`, and the caller could not tell the
  // difference between "these 380 are not related" and "these 380 were never
  // looked at" — the second reads as the first, because unrelated is defined as
  // the absence of a related flag. A caller that sends too many is now told.
  if (items.length > CLASSIFY_MAX_ITEMS) {
    return NextResponse.json(
      {
        error:
          `Too many titles in one request (${items.length}). Send at most ` +
          `${CLASSIFY_MAX_ITEMS} per request — use CLASSIFY_BATCH and loop.`,
      },
      { status: 400 }
    )
  }

  try {
    return NextResponse.json({ related: await classifyRelatedByGenre(items) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
