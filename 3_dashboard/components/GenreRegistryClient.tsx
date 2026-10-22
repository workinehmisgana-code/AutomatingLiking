'use client'

import { applyGenreRegistry, type CustomGenre } from '@/lib/genreRegistry'

/**
 * Writes the genres added in the admin into the browser's copy of the genre
 * tables, so client components read them exactly as the server does.
 *
 * During RENDER, not in an effect: it sits first in the root layout, so it runs
 * before any component after it reads GENRES or PRODUCTS. An effect would run
 * after those had already drawn the built-in genres only.
 */
export default function GenreRegistryClient({ list }: { list: CustomGenre[] }) {
  applyGenreRegistry(list)
  return null
}
