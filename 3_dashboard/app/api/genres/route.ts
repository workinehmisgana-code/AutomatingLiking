import { NextRequest, NextResponse } from 'next/server'
import { isAdminRequest } from '@/lib/machineAuth'
import { GENRES, GENRE_LABELS, productsInGenre } from '@/lib/config'
import { listCustomGenres } from '@/lib/genreStore'

export const dynamic = 'force-dynamic'

// GET — every genre, built-in and added, for the local tools: the control
// center's genre lists, the uploader's --genre, the harvester and the liker.
// Readable with LINKS_EXPORT_TOKEN (or an admin session), like /api/links/clusters.
//
// `searchPhrases` is the added genre's starting phrase list (one per line); the
// built-in genres keep theirs in the control center's own settings.
export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req, 'read'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const custom = await listCustomGenres().catch(() => [])
  const phrases = new Map(custom.map((g) => [g.id, g.searchPhrases]))
  return NextResponse.json({
    genres: GENRES.map((id) => ({
      id,
      label: GENRE_LABELS[id] ?? id,
      products: productsInGenre(id),
      searchPhrases: phrases.get(id) ?? '',
      builtin: !phrases.has(id),
    })),
  })
}
