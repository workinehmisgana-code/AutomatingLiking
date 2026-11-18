import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { BUILTIN_GENRES, GENRE_LABELS, isAdminEmail, isGenre } from '@/lib/config'
import { GENRE_COPY } from '@/lib/prompts'
import { builtinRelatedIsCustom, ensureGenreRegistry, resetBuiltinRelated, saveGenreRelated } from '@/lib/genreStore'

export const dynamic = 'force-dynamic'

// What counts as RELATED for one genre — what "Mark unrelated" asks about.
//
//   GET  ?genre=<id>                      { genre, label, subject, keywords, editable, builtin, custom }
//   POST { genre, subject, keywords[] }   save it
//   POST { genre, reset: true }           a built-in genre back to its code default
//
// An added genre's definition lives in the database (app_kv 'custom_genres').
// A built-in genre's is code (lib/prompts.ts); an edit to it is stored as an
// override (app_kv 'builtin_genre_related') and can be reset to the code's.

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
    editable: true,
    builtin: isBuiltin(genre),
    custom: isBuiltin(genre) && builtinRelatedIsCustom(genre),
  })
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as {
    genre?: unknown
    subject?: unknown
    keywords?: unknown
    reset?: unknown
  }
  const genre = String(b.genre ?? '').trim()
  await ensureGenreRegistry().catch(() => {})
  if (b.reset === true) {
    if (!isBuiltin(genre)) {
      return NextResponse.json({ error: 'Only a built-in genre has a default to reset to.' }, { status: 400 })
    }
    const related = await resetBuiltinRelated(genre)
    return NextResponse.json({ ok: true, genre, ...related, custom: false })
  }
  const keywords = Array.isArray(b.keywords)
    ? b.keywords.map(String)
    : String(b.keywords ?? '').split(/[\n,]+/)
  const r = await saveGenreRelated(genre, String(b.subject ?? ''), keywords)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ ok: true, genre, ...r.related, custom: isBuiltin(genre) })
}
