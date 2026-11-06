import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { BUILTIN_GENRES, GENRE_LABELS, isAdminEmail, isGenre } from '@/lib/config'
import { GENRE_COPY } from '@/lib/prompts'
import { ensureGenreRegistry, saveGenreRelated } from '@/lib/genreStore'

export const dynamic = 'force-dynamic'

// What counts as RELATED for one genre — what "Mark unrelated" asks about.
//
//   GET  ?genre=<id>                      { genre, label, subject, keywords, editable }
//   POST { genre, subject, keywords[] }   save it (added genres only)
//
// An added genre's definition lives in the database (app_kv 'custom_genres')
// and is edited here. A built-in genre's is code (lib/prompts.ts), so it is
// shown but not editable.

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

const isBuiltin = (g: string) => (BUILTIN_GENRES as readonly string[]).includes(g)

export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  await ensureGenreRegistry(true).catch(() => {})
  const genre = String(req.nextUrl.searchParams.get('genre') ?? '').trim()
  if (!isGenre(genre)) return NextResponse.json({ error: `Unknown genre: ${genre}` }, { status: 400 })
  const { subject, keywords } = GENRE_COPY[genre].related
  return NextResponse.json({
    genre,
    label: GENRE_LABELS[genre] ?? genre,
    subject,
    keywords,
    editable: !isBuiltin(genre),
  })
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as {
    genre?: unknown
    subject?: unknown
    keywords?: unknown
  }
  const genre = String(b.genre ?? '').trim()
  if (isBuiltin(genre)) {
    return NextResponse.json(
      { error: 'A built-in genre is defined in code (lib/prompts.ts), not the database.' },
      { status: 400 }
    )
  }
  const keywords = Array.isArray(b.keywords)
    ? b.keywords.map(String)
    : String(b.keywords ?? '').split(/[\n,]+/)
  const r = await saveGenreRelated(genre, String(b.subject ?? ''), keywords)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ ok: true, genre, ...r.related })
}
