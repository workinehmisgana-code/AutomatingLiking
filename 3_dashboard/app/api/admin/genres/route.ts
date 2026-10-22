import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, BUILTIN_GENRES, GENRE_LABELS, productsInGenre } from '@/lib/config'
import { deleteCustomGenre, listCustomGenres, saveCustomGenre } from '@/lib/genreStore'
import type { CustomGenre } from '@/lib/genreRegistry'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

// GET — the built-in genres (read-only) and the added ones (editable).
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const custom = await listCustomGenres()
  return NextResponse.json({
    builtin: BUILTIN_GENRES.map((g) => ({ id: g, label: GENRE_LABELS[g] ?? g, products: productsInGenre(g) })),
    custom,
  })
}

// POST { genre, isNew } — add a genre, or save changes to an added one.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { genre?: CustomGenre; isNew?: boolean }
  if (!body.genre) return NextResponse.json({ error: 'No genre given.' }, { status: 400 })
  const r = await saveCustomGenre(body.genre, body.isNew !== false)
  if (!r.ok) return NextResponse.json({ error: 'Not saved', problems: r.problems }, { status: 400 })
  return NextResponse.json({ ok: true, custom: r.list })
}

// DELETE { id } — remove an added genre.
export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { id?: string }
  const id = String(body.id ?? '').trim()
  if (!id || (BUILTIN_GENRES as readonly string[]).includes(id)) {
    return NextResponse.json({ error: 'Only an added genre can be removed.' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, custom: await deleteCustomGenre(id) })
}
