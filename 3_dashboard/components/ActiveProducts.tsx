'use client'

import { Fragment, useEffect, useState } from 'react'
import {
  CLICK_PLATFORMS,
  CLICK_PLATFORM_LABELS,
  GENRES,
  GENRE_LABELS,
  genreOfProduct,
} from '@/lib/config'

// Admin panel: choose which products' comments feed the app's comment pool, and
// which PLATFORMS each of those products may be served on.
//
// The two are separate decisions. "Active" is whether a product is being sold at
// all; the platform row is where it is sold. A product can be right for TikTok
// and wrong for Instagram — what reads as natural under a TikTok video is not
// what an Instagram audience is there for — and a product with no Instagram
// landing page should not be advertised to Instagram traffic at all.
//
// A product with EVERY platform ticked is stored as unrestricted rather than as
// a list of all four, so the default and the "all of them" case cannot drift
// apart, and adding a platform later does not silently exclude it from every
// product.
//
// GROUPED BY GENRE, with the count of active products per genre on the heading.
// A genre's serving share is divided between whichever of ITS products are
// active, and nothing else can take up the slack — so a genre that is given a
// share here and has nothing active is a share of the feed that serves no
// comment at all. In a flat list of eight that is invisible; under a heading
// reading "Slides — none active" it is the first thing you see.
export default function ActiveProducts({
  genre,
}: {
  /**
   * Show only this genre's products, from the admin's master switch.
   *
   * A FILTER ON WHAT IS DRAWN, NOT ON WHAT IS HELD. `products`, `active` and
   * `platforms` below still describe every genre, and they must: toggling a
   * product writes back the whole active set, and changing a platform rebuilds
   * the whole platform map from `products`. Filtered state would mean that
   * switching one website product's platforms silently erased every humanizer
   * product's restrictions — the screen would look right and the stored
   * setting would be gone.
   */
  genre?: string
} = {}) {
  const [open, setOpen] = useState(false)
  const [products, setProducts] = useState<string[] | null>(null)
  const [active, setActive] = useState<Set<string>>(new Set())
  // { product: platforms }. A product ABSENT from this map is allowed
  // everywhere — which is every product until an admin narrows one.
  const [platforms, setPlatforms] = useState<Record<string, string[]>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')

  useEffect(() => {
    if (!open || products) return
    fetch('/api/admin/active-products')
      .then((r) => r.json())
      .then((d) => {
        if (d?.products) {
          setProducts(d.products)
          setActive(new Set<string>(d.active ?? []))
          setPlatforms(d.platforms ?? {})
        } else setError(d?.error || 'Could not load products.')
      })
      .catch(() => setError('Could not load products.'))
  }, [open, products])

  async function post(body: Record<string, unknown>, onOk: (d: Record<string, unknown>) => void) {
    setSaving(true)
    setError('')
    setSavedNote('')
    try {
      const res = await fetch('/api/admin/active-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d?.error || 'Could not save.')
        return
      }
      onOk(d)
      setSavedNote('Saved ✓')
      setTimeout(() => setSavedNote(''), 1500)
    } catch {
      setError('Network error while saving.')
    } finally {
      setSaving(false)
    }
  }

  function toggle(p: string) {
    const next = new Set(active)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setActive(next)
    void post({ active: Array.from(next) }, (d) => {
      if (Array.isArray(d?.active)) setActive(new Set<string>(d.active as string[]))
    })
  }

  /** Which platforms this product is currently allowed on. Absent = all. */
  function sitesOf(product: string): string[] {
    const saved = platforms[product]
    return saved === undefined ? [...CLICK_PLATFORMS] : saved
  }

  function togglePlatform(product: string, platform: string) {
    const current = new Set(sitesOf(product))
    if (current.has(platform)) current.delete(platform)
    else current.add(platform)
    // Send the WHOLE map, not one product: the endpoint replaces it, and
    // sending one product would drop every other product's setting.
    const next: Record<string, string[]> = {}
    for (const p of products ?? []) next[p] = p === product ? Array.from(current) : sitesOf(p)
    setPlatforms(next)
    void post({ platforms: next }, (d) => {
      if (d?.platforms && typeof d.platforms === 'object') {
        setPlatforms(d.platforms as Record<string, string[]>)
      }
    })
  }

  return (
    <div className="border border-zinc-800 rounded-xl bg-zinc-900/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 p-3 text-left"
        aria-expanded={open}
      >
        <span className="text-sm font-medium text-zinc-200">
          💬 App comment pool
          <span className="text-zinc-500 font-normal">
            {' '}— which products are served, and on which platforms
          </span>
        </span>
        <span className={`text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-500 mb-3 leading-relaxed">
            A user is served a comment from one of the ACTIVE products on every link they open.
            Under each active product, tick the platforms its comments may appear on — untick one
            and that product is never served on that site, by the app, the website or the liker.
            All platforms ticked means no restriction.
          </p>
          {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
          {savedNote && <p className="text-sm text-emerald-400 mb-2">{savedNote}</p>}

          {!products ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : products.length === 0 ? (
            <p className="text-sm text-zinc-500">No active products available.</p>
          ) : (
            <div className="space-y-2">
              {/* Genre order, then anything whose genre is not one we know —
                  a product can only be dropped from the config, never from a
                  list the server already returned. */}
              {(() => {
                const known = GENRES.flatMap((g) => products.filter((p) => genreOfProduct(p) === g))
                const ordered = [...known, ...products.filter((p) => !known.includes(p))]
                // Narrowed for DRAWING only; see the prop.
                return genre ? ordered.filter((p) => genreOfProduct(p) === genre) : ordered
              })().map((p, i, ordered) => {
                const on = active.has(p)
                const sites = sitesOf(p)
                const g = genreOfProduct(p)
                // First of its genre in the ordered list carries the heading.
                const first = ordered.findIndex((q) => genreOfProduct(q) === g) === i
                const inGenre = ordered.filter((q) => genreOfProduct(q) === g)
                const liveInGenre = inGenre.filter((q) => active.has(q)).length
                return (
                  <Fragment key={p}>
                  {first && (
                    <div className="flex items-baseline gap-2 pt-1 first:pt-0">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                        {GENRE_LABELS[g] ?? g}
                      </span>
                      <span
                        className={
                          liveInGenre === 0 ? 'text-[10px] text-amber-400/90' : 'text-[10px] text-zinc-600'
                        }
                        title={
                          liveInGenre === 0
                            ? "No product in this genre is active, so its share of the feed serves no comment \u2014 set the share to 0 or switch one on."
                            : `${liveInGenre} of ${inGenre.length} active in this genre`
                        }
                      >
                        {liveInGenre === 0
                          ? '\u2014 none active'
                          : `\u2014 ${liveInGenre} of ${inGenre.length} active`}
                      </span>
                    </div>
                  )}
                  <div
                    className={`rounded-lg border p-2 transition-colors ${
                      on ? 'border-emerald-600/40 bg-emerald-600/5' : 'border-zinc-800 bg-zinc-900/40'
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        disabled={saving}
                        onClick={() => toggle(p)}
                        className={`text-sm rounded-lg px-3 py-1.5 border transition-colors disabled:opacity-60 capitalize ${
                          on
                            ? 'border-emerald-500 bg-emerald-600/15 text-emerald-200'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-600'
                        }`}
                      >
                        {on ? '✓ ' : ''}
                        {p}
                      </button>
                      {/* Shown for inactive products too, greyed: the setting is
                          remembered, and hiding it would make re-activating a
                          product a guess about where it will appear. */}
                      <div className={`flex flex-wrap items-center gap-1.5 ${on ? '' : 'opacity-40'}`}>
                        {CLICK_PLATFORMS.map((plat) => {
                          const ticked = sites.includes(plat)
                          return (
                            <button
                              key={plat}
                              disabled={saving}
                              onClick={() => togglePlatform(p, plat)}
                              title={
                                ticked
                                  ? `${p} is served on ${CLICK_PLATFORM_LABELS[plat] ?? plat}`
                                  : `${p} is never served on ${CLICK_PLATFORM_LABELS[plat] ?? plat}`
                              }
                              className={`text-[11px] rounded px-2 py-1 border transition-colors disabled:opacity-60 ${
                                ticked
                                  ? 'border-teal-600/50 bg-teal-600/15 text-teal-200'
                                  : 'border-zinc-700 bg-zinc-900 text-zinc-500 hover:border-zinc-600'
                              }`}
                            >
                              {ticked ? '✓ ' : ''}
                              {CLICK_PLATFORM_LABELS[plat] ?? plat}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    {/* The one state that silently serves nothing. */}
                    {on && sites.length === 0 && (
                      <p className="text-[11px] text-amber-400 mt-1.5">
                        ⚠ Active but allowed on no platform — this product is never served anywhere.
                      </p>
                    )}
                  </div>
                  </Fragment>
                )
              })}
            </div>
          )}

          {products && active.size === 0 && (
            <p className="text-xs text-amber-400 mt-3">
              ⚠ No products active — the app will have an empty comment pool.
            </p>
          )}
          {/* A platform no active product covers serves no comment at all, which
              is invisible until someone opens a link there and gets nothing. */}
          {products && active.size > 0 && (
            <>
              {CLICK_PLATFORMS.filter(
                (plat) => !Array.from(active).some((p) => sitesOf(p).includes(plat))
              ).map((plat) => (
                <p key={plat} className="text-xs text-amber-400 mt-2">
                  ⚠ No active product is allowed on {CLICK_PLATFORM_LABELS[plat] ?? plat} — links
                  there will be served no comment.
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
