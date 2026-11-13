'use client'

import { useEffect, useState } from 'react'

type Rule = {
  enabled: boolean
  product: string
  minUsers: number
  requireScanned: boolean
  reserved: boolean
}

/**
 * Admin: give the links many workers opened, but where none of our comments
 * stuck, to one product (lib/db ReviveRule). They come back into the feeds even
 * though they are retired, and are served that product only.
 */
export default function ReviveRule() {
  const [saved, setSaved] = useState<Rule | null>(null)
  const [draft, setDraft] = useState<Rule | null>(null)
  const [products, setProducts] = useState<string[]>([])
  const [active, setActive] = useState<string[]>([])
  const [covered, setCovered] = useState(0)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  type Reply = { rule: Rule; products: string[]; active: string[]; covered: number; error?: string }
  const take = (d: Reply) => {
    setSaved(d.rule)
    setDraft(d.rule)
    setProducts(d.products || [])
    setActive(d.active || [])
    setCovered(Number(d.covered) || 0)
  }

  useEffect(() => {
    fetch('/api/admin/revive-rule', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && take(d))
      .catch(() => {})
  }, [])

  async function save(rule: Rule) {
    setBusy(true)
    setNote('')
    try {
      const res = await fetch('/api/admin/revive-rule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setNote(d?.error || 'Could not save.')
        return
      }
      take(d)
      setNote('Saved — the feeds use it within a few minutes.')
    } finally {
      setBusy(false)
    }
  }

  if (!saved || !draft) return <div className="text-xs text-zinc-600">Loading the revive rule…</div>
  const changed = JSON.stringify(saved) !== JSON.stringify(draft)
  const num = 'w-14 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-zinc-100 tabular-nums'
  const set = (patch: Partial<Rule>) => setDraft({ ...draft, ...patch })
  const inactive = !active.includes(draft.product)

  return (
    <div className="mt-3 rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
        <span className="text-sm font-semibold text-white">♻️ Revive opened links with none of ours</span>
        <span
          className={`text-[11px] rounded px-1.5 py-0.5 border ${
            saved.enabled
              ? 'text-emerald-200 bg-emerald-600/15 border-emerald-500/40'
              : 'text-zinc-400 bg-zinc-800 border-zinc-700'
          }`}
        >
          {saved.enabled ? `on · ${covered.toLocaleString()} link(s) for ${saved.product} now` : 'off'}
        </span>
      </div>

      <div className="mt-2 space-y-1.5 text-xs text-zinc-300">
        <label className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={busy} />
          <span>Advertise</span>
          <select
            value={draft.product}
            onChange={(e) => set({ product: e.target.value })}
            disabled={busy}
            className="bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-100"
          >
            {products.map((p) => (
              <option key={p} value={p}>
                {p}
                {active.includes(p) ? '' : ' (not active)'}
              </option>
            ))}
          </select>
          <span>on links opened by more than</span>
          <input
            type="number"
            min={0}
            value={draft.minUsers}
            onChange={(e) => set({ minUsers: Number(e.target.value) })}
            disabled={busy}
            className={num}
          />
          <span>workers that have none of our other products&apos; comments on them</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.requireScanned}
            onChange={(e) => set({ requireScanned: e.target.checked })}
            disabled={busy}
          />
          <span>Only links the comment scan has read (an unscanned link may carry ours)</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.reserved}
            onChange={(e) => set({ reserved: e.target.checked })}
            disabled={busy}
          />
          <span>Serve {draft.product} on these links only (nowhere else)</span>
        </label>
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => void save(draft)}
            disabled={busy || !changed}
            className="text-xs text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          {note && <span className="text-[11px] text-emerald-400">{note}</span>}
        </div>
        {draft.enabled && inactive && (
          <p className="text-[11px] text-amber-300">
            {draft.product} is not turned on under Active products, so nothing is served for it yet.
          </p>
        )}
      </div>
      <p className="text-[11px] text-zinc-600 mt-1.5">
        Only this product is served on these links, whatever product leads them. They retire only
        when our comments crowd them (the comment-share rule above), never by how many times they
        were served. Workers who opened a link before never see it again. &quot;None of ours&quot; comes from the comment
        scan, which reads TikTok.
      </p>
    </div>
  )
}
