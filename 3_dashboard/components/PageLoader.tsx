'use client'

import Link from 'next/link'

// Lightweight in-page states for the client-loaded task pages. The page shell
// itself is static (renders instantly on navigation); these fill the content
// area while the data request is in flight or if it fails.
export function PageLoader({ label }: { label: string }) {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 px-4">
      <div className="w-8 h-8 rounded-full border-2 border-zinc-700 border-t-emerald-500 animate-spin" />
      <p className="text-sm text-zinc-500">{label}</p>
    </div>
  )
}

const Block = ({ className = '' }: { className?: string }) => (
  <div className={`rounded-lg bg-zinc-800/80 ${className}`} />
)

// Skeleton placeholder that mirrors each page's layout, shown immediately on
// navigation so the page clearly "opens" while its data loads from the DB.
export function PageSkeleton({
  title,
  variant,
}: {
  title: string
  variant: 'comments' | 'video' | 'promo'
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
      {/* Header row: title + a back-button placeholder */}
      <div className="flex items-center justify-between mb-5">
        <Block className="h-6 w-44" />
        <Block className="h-8 w-20" />
      </div>

      <div className="animate-pulse space-y-4">
        {variant === 'comments' && (
          <>
            <Block className="h-10 w-full" />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {Array.from({ length: 9 }).map((_, i) => (
                <Block key={i} className="h-16" />
              ))}
            </div>
          </>
        )}

        {variant === 'video' && (
          <>
            <Block className="h-28 w-full" />
            <Block className="h-6 w-40" />
            {Array.from({ length: 3 }).map((_, i) => (
              <Block key={i} className="h-12 w-full" />
            ))}
          </>
        )}

        {variant === 'promo' && (
          <>
            <Block className="h-24 w-full" />
            <Block className="h-40 w-full" />
            {Array.from({ length: 2 }).map((_, i) => (
              <Block key={i} className="h-52 w-full" />
            ))}
          </>
        )}
      </div>

      <p className="text-center text-sm text-zinc-500 mt-6">Loading {title}…</p>
    </div>
  )
}

export function PageError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-3xl">📶</p>
      <p className="text-sm text-zinc-400">Couldn&apos;t load this page.</p>
      <div className="flex gap-2">
        <button
          onClick={onRetry}
          className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
        >
          Retry
        </button>
        <Link
          href="/"
          className="text-sm text-zinc-300 border border-zinc-700 rounded-lg px-3 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Links
        </Link>
      </div>
    </div>
  )
}
