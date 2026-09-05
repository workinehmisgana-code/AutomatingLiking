import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { classifyRelated, type Item } from '@/lib/titleClassify'

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
  let items: Item[] = []
  try {
    const b = await req.json()
    if (Array.isArray(b?.items)) {
      items = b.items
        .map((it: unknown) => {
          const o = it as { url?: unknown; title?: unknown }
          return { url: String(o?.url ?? '').trim(), title: String(o?.title ?? '').trim() }
        })
        .filter((it: Item) => it.url && it.title)
        .slice(0, 120)
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (items.length === 0) return NextResponse.json({ related: [] })

  try {
    return NextResponse.json({ related: await classifyRelated(items) })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
