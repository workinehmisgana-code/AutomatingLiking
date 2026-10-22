'use client'

import { useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { ADMIN_GENRE_COOKIE, GENRES, GENRE_LABELS, productsInGenre } from '@/lib/config'

/**
 * The master genre switch, at the top of every admin page.
 *
 * Every number on the admin is about ONE genre at a time: the links, the
 * clicks, the comments, the products, and each worker's share of the pay. This
 * is the one place that choice is made, so no screen can be on a different
 * genre from the one beside it.
 *
 * It writes a cookie and re-renders, rather than holding the choice in this
 * component's state: the pages that need it are server-rendered, and a choice
 * that only the browser knows about is one the server queries ignore.
 */
export default function GenreSwitch({
  current,
  children,
}: {
  current: string
  /** Shown in the same bar, after the genres (the users' messages). */
  children?: ReactNode
}) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)

  function choose(genre: string) {
    if (genre === current) return
    setPending(genre)
    // A year, path=/ so the admin API routes see it as well as the pages. Lax,
    // because this only ever governs what the admin's own screens show.
    document.cookie =
      `${ADMIN_GENRE_COOKIE}=${encodeURIComponent(genre)}; path=/; ` +
      `max-age=${60 * 60 * 24 * 365}; samesite=lax`
    router.refresh()
    // refresh() does not resolve when the render lands, so the pending state is
    // cleared on a timer; the new page replaces this one regardless.
    setTimeout(() => setPending(null), 1500)
  }

  return (
    <div className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">Genre</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Admin genre">
          {GENRES.map((g) => {
            const on = (pending ?? current) === g
            return (
              <button
                key={g}
                role="radio"
                aria-checked={on}
                onClick={() => choose(g)}
                className={
                  'text-sm rounded-lg px-3 py-1 border transition-colors ' +
                  (on
                    ? 'border-emerald-500 bg-emerald-600/20 text-emerald-200'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700')
                }
                title={`Products: ${productsInGenre(g).join(', ') || 'none'}`}
              >
                {GENRE_LABELS[g] ?? g}
              </button>
            )
          })}
          {/* Add or edit a genre (Admin → Genres). */}
          <a
            href="/admin/genres"
            title="Add a genre, or edit an added one"
            className="text-sm rounded-lg px-2.5 py-1 border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-200 hover:border-zinc-500"
          >
            + Genre
          </a>
        </div>
        {children}
        {/* The Comment Tester app's 💬 list (not genre-scoped: tester only). */}
        <a
          href="/admin/tester-comments"
          title="Comments shown in the Comment Tester app's 💬 list"
          className="text-sm rounded-lg px-2.5 py-1 border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
        >
          🧪 Tester comments
        </a>
        {/* Says what is being looked at, in words, so a screenshot of any admin
            page carries its own genre. */}
        <span className="text-[11px] text-zinc-600 ml-auto">
          {pending ? 'switching…' : `everything below is ${GENRE_LABELS[current] ?? current}`}
        </span>
      </div>
    </div>
  )
}
