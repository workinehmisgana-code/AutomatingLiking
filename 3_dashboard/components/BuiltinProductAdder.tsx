'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { COMMENTS } from '@/lib/comments'
import { productWords } from '@/lib/config'
import type { ExtraProduct } from '@/lib/genreRegistry'

type Form = { id: string; site: string; words: string; note: string; seeds: string; isNew: boolean }

const BLANK: Form = { id: '', site: '', words: '', note: '', seeds: '', isNew: true }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Add a product to a BUILT-IN genre — a new humanizer next to purifytext and
 * the rest — from Admin → Genres. The genre's prompts, audiences and link pool
 * are already there; a product needs only its name, its site, how comments
 * write the name, and the base comments its comment sets are rewritten from.
 *
 * The base comments can be started from an existing product's, with the name
 * swapped: they are the same kind of product, so the same kind of comment.
 */
export default function BuiltinProductAdder({
  genre,
  label,
  builtinProducts,
  extras,
  onChange,
}: {
  genre: string
  label: string
  /** The genre's products, built-in and added — the ones to copy comments from. */
  builtinProducts: string[]
  /** The products added to THIS genre from the admin. */
  extras: ExtraProduct[]
  onChange: (list: ExtraProduct[]) => void
}) {
  const router = useRouter()
  const [form, setForm] = useState<Form | null>(null)
  const [from, setFrom] = useState(builtinProducts[0] ?? '')
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [note, setNote] = useState('')

  const sources = builtinProducts.filter((p) => (COMMENTS[p]?.length ?? 0) > 0 && p !== form?.id)

  function copySeeds() {
    if (!form || !from) return
    if (!form.id) {
      setProblems(['Type the product name first, so the copied comments can use it.'])
      return
    }
    // Swap the source's name for the new one, in either spelling — "purifytext"
    // and "purify text" alike. Whatever the comments say about the product
    // itself carries over: both are humanizers.
    const names = Array.from(new Set([productWords(from), from])).sort((a, b) => b.length - a.length)
    const re = new RegExp(names.map(esc).join('|'), 'gi')
    const seeds = (COMMENTS[from] ?? []).map((s) => s.replace(re, form.id))
    setForm({ ...form, seeds: seeds.join('\n') })
    setProblems([])
  }

  async function save() {
    if (!form) return
    setBusy(true)
    setProblems([])
    try {
      const res = await fetch('/api/admin/genres/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: form.id,
          genre,
          site: form.site,
          words: form.words,
          note: form.note,
          seeds: form.seeds.split(/\r?\n/),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setProblems(d?.problems ?? [d?.error || 'Could not save.'])
        return
      }
      onChange(d.products)
      setNote(
        `Saved ${form.id}. Next: open its comments page and generate its comments, then turn it ` +
          `on under Active products on the admin dashboard.`
      )
      setForm(null)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove(x: ExtraProduct) {
    if (
      !confirm(
        `Remove ${x.id} from ${label}?\n\nIt stops being served and its comments stop being ` +
          'generated. Clicks and comments already recorded for it are kept.'
      )
    )
      return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/genres/products', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: x.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        alert(d?.error || 'Could not remove.')
        return
      }
      onChange(d.products)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500'
  const seedCount = form ? form.seeds.split(/\r?\n/).filter((s) => s.trim()).length : 0

  return (
    <div className="mt-1.5 ml-3 space-y-1.5">
      {extras.map((x) => (
        <div key={x.id} className="flex items-center gap-2 text-xs">
          <span className="text-zinc-300">+ {x.id}</span>
          {x.site && <span className="text-zinc-600">{x.site}</span>}
          <span className="text-zinc-600">added · {x.seeds.length} base comments</span>
          <a href={`/admin/comments/${x.id}`} className="text-emerald-400 hover:underline">
            comments
          </a>
          <span className="ml-auto flex gap-2">
            <button
              onClick={() => {
                setForm({ id: x.id, site: x.site, words: x.words, note: x.note ?? '', seeds: x.seeds.join('\n'), isNew: false })
                setProblems([])
                setNote('')
              }}
              className="text-xs text-zinc-300 border border-zinc-700 rounded px-2 py-0.5 hover:bg-zinc-800"
            >
              Edit
            </button>
            <button
              onClick={() => void remove(x)}
              disabled={busy}
              className="text-xs text-red-300 border border-red-900/60 rounded px-2 py-0.5 hover:bg-red-950/40"
            >
              Remove
            </button>
          </span>
        </div>
      ))}

      {!form && (
        <button
          onClick={() => {
            setForm({ ...BLANK })
            setProblems([])
            setNote('')
          }}
          className="text-xs text-white bg-emerald-700 hover:bg-emerald-600 rounded px-2.5 py-1"
        >
          + Add a {label} product
        </button>
      )}
      {note && <p className="text-xs text-emerald-300">{note}</p>}

      {form && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-3">
          <div className="text-sm font-semibold text-white">
            {form.isNew ? `New ${label} product` : `Edit ${form.id}`}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="block text-xs text-zinc-300 mb-1">Name</span>
              <span className="block text-[11px] text-zinc-500 mb-1">As comments say it: lowercase, no spaces</span>
              <input
                className={input}
                placeholder="e.g. cohumanly"
                value={form.id}
                disabled={!form.isNew}
                onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') })}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-zinc-300 mb-1">Site</span>
              <span className="block text-[11px] text-zinc-500 mb-1">Optional</span>
              <input
                className={input}
                placeholder="e.g. cohumanly.com"
                value={form.site}
                onChange={(e) => setForm({ ...form, site: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="block text-xs text-zinc-300 mb-1">Written in comments as</span>
              <span className="block text-[11px] text-zinc-500 mb-1">Optional: the name in words</span>
              <input
                className={input}
                placeholder={form.id ? `e.g. ${form.id.slice(0, 2)} ${form.id.slice(2)}` : 'e.g. co humanly'}
                value={form.words}
                onChange={(e) => setForm({ ...form, words: e.target.value })}
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-xs text-zinc-300 mb-1">How comments talk about it</span>
            <span className="block text-[11px] text-zinc-500 mb-1">
              Optional: an instruction to the comment writer that overrides the genre&apos;s usual
              message. {'{PRODUCT}'} is the name as comments write it.
            </span>
            <textarea
              rows={3}
              className={input + ' text-xs'}
              placeholder='e.g. Talk about {PRODUCT} as an idea — the step you run AI text through — not as a brand you recommend.'
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </label>

          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="text-xs text-zinc-300">Base comments</span>
              <span className="text-[11px] text-zinc-500">
                one per line, at least 5, each naming the product · {seedCount} now
              </span>
              {sources.length > 0 && (
                <span className="ml-auto flex items-center gap-1.5 text-[11px] text-zinc-400">
                  start from
                  <select
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className="bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-100"
                  >
                    {sources.map((p) => (
                      <option key={p} value={p}>
                        {p} ({COMMENTS[p].length})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={copySeeds}
                    className="text-xs text-zinc-200 border border-zinc-700 rounded px-2 py-0.5 hover:bg-zinc-800"
                  >
                    Copy with the name swapped
                  </button>
                </span>
              )}
            </div>
            <textarea
              rows={8}
              className={input + ' font-mono text-xs leading-relaxed'}
              value={form.seeds}
              onChange={(e) => setForm({ ...form, seeds: e.target.value })}
              placeholder={`i just use ${form.id || 'cohumanly'}, it always passes for me`}
            />
          </div>

          {problems.length > 0 && (
            <ul className="text-xs text-red-300 list-disc pl-5 space-y-0.5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => void save()}
              disabled={busy}
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg px-3 py-1.5"
            >
              {busy ? 'Saving…' : form.isNew ? 'Add product' : 'Save'}
            </button>
            <button
              onClick={() => {
                setForm(null)
                setProblems([])
              }}
              className="text-sm text-zinc-300 border border-zinc-700 rounded-lg px-3 py-1.5 hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
