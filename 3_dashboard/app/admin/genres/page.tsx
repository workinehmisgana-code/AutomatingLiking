import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminEmail, BUILTIN_GENRES, GENRE_LABELS, productsInGenre } from '@/lib/config'
import { listCustomGenres } from '@/lib/genreStore'
import Login from '@/components/Login'
import GenreAdmin from '@/components/GenreAdmin'

export const dynamic = 'force-dynamic'

// Admin → Genres: the built-in genres, and the form to add more.
export default async function GenresPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')

  const custom = await listCustomGenres().catch(() => [])
  return (
    <GenreAdmin
      builtin={BUILTIN_GENRES.map((g) => ({ id: g, label: GENRE_LABELS[g] ?? g, products: productsInGenre(g) }))}
      custom={custom}
    />
  )
}
