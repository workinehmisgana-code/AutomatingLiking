'use client'

import { useEffect, useState } from 'react'

// Admin panel: choose which products' comments feed the app's comment pool. The
// app doesn't show a comments list — on each Next it copies a random comment
// drawn from the ACTIVE products chosen here.
export default function ActiveProducts() {
  const [open, setOpen] = useState(false)
  const [products, setProducts] = useState<string[] | null>(null)
  const [active, setActive] = useState<Set<string>>(new Set())
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
        } else setError(d?.error || 'Could not load products.')
      })
      .catch(() => setError('Could not load products.'))
  }, [open, products])

  async function save(next: Set<string>) {
    setSaving(true)
    setError('')
    setSavedNote('')
    try {
      const res = await fetch('/api/admin/active-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: Array.from(next) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d?.error || 'Could not save.')
        return
      }
      if (Array.isArray(d?.active)) setActive(new Set<string>(d.active))
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
    save(next)
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
          <span className="text-zinc-500 font-normal"> — active products the app copies from</span>
        </span>
        <span className={`text-zinc-500 transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
      </button>

      {open && (
        <div className="px-3 pb-3 border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-500 mb-3">
            The app copies a random comment from these products on every Next. Tick the products whose
            comments should be in the pool. Untick a product to leave it out.
          </p>
          {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
          {savedNote && <p className="text-sm text-emerald-400 mb-2">{savedNote}</p>}

          {!products ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : products.length === 0 ? (
            <p className="text-sm text-zinc-500">No active products available.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {products.map((p) => {
                const on = active.has(p)
                return (
                  <button
                    key={p}
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
                )
              })}
            </div>
          )}
          {products && active.size === 0 && (
            <p className="text-xs text-amber-400 mt-3">
              ⚠ No products active — the app will have an empty comment pool.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
