'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { CustomGenre } from '@/lib/genreRegistry'

type Builtin = { id: string; label: string; products: string[] }

/** The form's own shape: everything a genre needs, as editable text. */
type Form = {
  id: string
  label: string
  products: { id: string; site: string }[]
  description: string
  what: string
  voice: string
  angleCompetitors: string
  angleGeneric: string
  jargon: string
  replyRelevance: string
  replyMention: string
  promo: string
  relatedSubject: string
  relatedKeywords: string
  curiousAside: string
  recommendVerbs: string
  plainFact: string
  seeds: Record<string, string>
  searchPhrases: string
}

const EMPTY: Form = {
  id: '',
  label: '',
  products: [{ id: '', site: '' }],
  description: '',
  what: '',
  voice: '',
  angleCompetitors: '',
  angleGeneric: '',
  jargon: '',
  replyRelevance: '',
  replyMention: '',
  promo: '',
  relatedSubject: '',
  relatedKeywords: '',
  curiousAside: '',
  recommendVerbs: '',
  plainFact: '',
  seeds: {},
  searchPhrases: '',
}

const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31)

function fromGenre(g: CustomGenre): Form {
  return {
    id: g.id,
    label: g.label,
    products: g.products.map((p) => ({ ...p })),
    description: '',
    what: g.copy.what,
    voice: g.copy.voice,
    angleCompetitors: g.copy.angles.competitors,
    angleGeneric: g.copy.angles.generic,
    jargon: g.copy.jargon.join('\n'),
    replyRelevance: g.copy.replyRelevance,
    replyMention: g.copy.replyMention,
    promo: g.copy.promo,
    relatedSubject: g.copy.related.subject,
    relatedKeywords: g.copy.related.keywords.join(', '),
    curiousAside: g.copy.voiceExamples.curiousAside,
    recommendVerbs: g.copy.voiceExamples.recommendVerbs,
    plainFact: g.copy.voiceExamples.plainFact,
    seeds: Object.fromEntries(Object.entries(g.seeds).map(([k, v]) => [k, v.join('\n')])),
    searchPhrases: g.searchPhrases,
  }
}

function toGenre(f: Form): CustomGenre {
  return {
    id: f.id.trim(),
    label: f.label.trim(),
    products: f.products
      .map((p) => ({ id: p.id.trim().toLowerCase(), site: p.site.trim() }))
      .filter((p) => p.id),
    copy: {
      what: f.what,
      voice: f.voice,
      angles: { competitors: f.angleCompetitors, ai_detector: f.angleGeneric, generic: f.angleGeneric },
      jargon: lines(f.jargon),
      replyRelevance: f.replyRelevance,
      replyMention: f.replyMention,
      promo: f.promo,
      related: {
        subject: f.relatedSubject,
        keywords: f.relatedKeywords.split(/[\n,]+/).map((k) => k.trim()).filter(Boolean),
      },
      voiceExamples: {
        curiousAside: f.curiousAside,
        recommendVerbs: f.recommendVerbs,
        plainFact: f.plainFact,
      },
    },
    seeds: Object.fromEntries(
      f.products.filter((p) => p.id.trim()).map((p) => [p.id.trim().toLowerCase(), lines(f.seeds[p.id] ?? '')])
    ),
    searchPhrases: f.searchPhrases,
  }
}

// At module level, not inside the form: a component declared during render is a
// new component every keystroke, and React would remount the input under the
// cursor and drop focus after each letter.
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-300 mb-1">{label}</span>
      {hint && <span className="block text-[11px] text-zinc-500 mb-1">{hint}</span>}
      {children}
    </label>
  )
}

/**
 * Admin → Genres. Add a product category — its products, how its comments
 * sound, what counts as related to it — and it is live everywhere at once: the
 * genre switch, the genre mix, uploads, the feeds, comments, the liker and the
 * control center. See lib/genreRegistry.ts for where each field lands.
 */
export default function GenreAdmin({
  builtin,
  custom: initial,
}: {
  builtin: Builtin[]
  custom: CustomGenre[]
}) {
  const router = useRouter()
  const [custom, setCustom] = useState(initial)
  const [form, setForm] = useState<Form | null>(null)
  const [isNew, setIsNew] = useState(true)
  const [busy, setBusy] = useState<'' | 'draft' | 'save' | 'delete'>('')
  const [problems, setProblems] = useState<string[]>([])
  const [note, setNote] = useState('')

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  async function draft() {
    if (!form) return
    setBusy('draft')
    setNote('')
    setProblems([])
    try {
      const res = await fetch('/api/admin/genres/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: form.label, products: form.products, description: form.description }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setProblems([d?.error || 'Could not draft.']); return }
      const x = d.draft as Record<string, unknown>
      const str = (k: string) => (typeof x[k] === 'string' ? (x[k] as string) : '')
      const arr = (k: string) => (Array.isArray(x[k]) ? (x[k] as unknown[]).map(String) : [])
      const seeds: Record<string, string> = {}
      for (const p of form.products) {
        if (!p.id.trim()) continue
        seeds[p.id] = arr('seeds').map((s) => s.replace(/\{PRODUCT\}/g, p.id.trim().toLowerCase())).join('\n')
      }
      setForm({
        ...form,
        what: str('what'),
        voice: str('voice'),
        angleCompetitors: str('angleCompetitors'),
        angleGeneric: str('angleGeneric'),
        jargon: arr('jargon').join('\n'),
        replyRelevance: str('replyRelevance'),
        replyMention: str('replyMention'),
        promo: str('promo'),
        relatedSubject: str('relatedSubject'),
        relatedKeywords: arr('relatedKeywords').join(', '),
        curiousAside: str('voiceCuriousAside'),
        recommendVerbs: str('voiceRecommendVerbs'),
        plainFact: str('voicePlainFact'),
        seeds,
        searchPhrases: arr('searchPhrases').join('\n'),
      })
      setNote(`Drafted with ${d.model}. Read it through and change anything before saving.`)
    } finally {
      setBusy('')
    }
  }

  async function save() {
    if (!form) return
    setBusy('save')
    setProblems([])
    try {
      const res = await fetch('/api/admin/genres', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ genre: toGenre(form), isNew }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setProblems(d?.problems ?? [d?.error || 'Could not save.']); return }
      setCustom(d.custom)
      setForm(null)
      setNote(`Saved "${form.label}". Turn its products on under Active products and give it a share in the genre mix to start serving it.`)
      router.refresh()
    } finally {
      setBusy('')
    }
  }

  async function remove(g: CustomGenre) {
    if (!confirm(
      `Remove the genre "${g.label}"?\n\nIts products (${g.products.map((p) => p.id).join(', ')}) stop ` +
        'being served and their comments stop being generated. Links uploaded into it stay in the ' +
        'pool but are no longer in any genre you can select, and read as Humanizer.'
    )) return
    setBusy('delete')
    try {
      const res = await fetch('/api/admin/genres', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: g.id }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { alert(d?.error || 'Could not remove.'); return }
      setCustom(d.custom)
      router.refresh()
    } finally {
      setBusy('')
    }
  }

  const input =
    'w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-emerald-500'
  const area = input + ' font-mono text-xs leading-relaxed'

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-bold text-white">Genres</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            A genre is a kind of product with its own links, comments and share of what workers are served.
          </p>
        </div>
        <Link href="/admin" className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5">
          Dashboard
        </Link>
      </div>

      {note && <p className="mb-4 text-sm text-emerald-300">{note}</p>}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 mb-5">
        <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Genres</div>
        <ul className="space-y-1.5 text-sm">
          {builtin.map((g) => (
            <li key={g.id} className="flex items-center gap-2">
              <span className="text-white">{g.label}</span>
              <span className="text-zinc-500 text-xs">{g.products.join(', ')}</span>
              <span className="ml-auto text-[11px] text-zinc-600">built in</span>
            </li>
          ))}
          {custom.map((g) => (
            <li key={g.id} className="flex items-center gap-2">
              <span className="text-white">{g.label}</span>
              <span className="text-zinc-500 text-xs">{g.products.map((p) => p.id).join(', ')}</span>
              <span className="ml-auto flex gap-2">
                <button
                  onClick={() => { setForm(fromGenre(g)); setIsNew(false); setProblems([]); setNote('') }}
                  className="text-xs text-zinc-300 border border-zinc-700 rounded px-2 py-0.5 hover:bg-zinc-800"
                >
                  Edit
                </button>
                <button
                  onClick={() => void remove(g)}
                  disabled={busy !== ''}
                  className="text-xs text-red-300 border border-red-900/60 rounded px-2 py-0.5 hover:bg-red-950/40"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
        {!form && (
          <button
            onClick={() => { setForm({ ...EMPTY, products: [{ id: '', site: '' }] }); setIsNew(true); setProblems([]); setNote('') }}
            className="mt-3 text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5"
          >
            + Add a genre
          </button>
        )}
      </div>

      {form && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-5">
          <div className="text-sm font-semibold text-white">{isNew ? 'New genre' : `Edit ${form.label}`}</div>

          {/* ── 1. the basics ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" hint="Shown on the genre switch, e.g. Video editor">
              <input
                className={input}
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value, id: isNew ? slug(e.target.value) : form.id })}
              />
            </Field>
            <Field label="Id" hint="Stored on every link of this genre; cannot be changed later">
              <input className={input} value={form.id} disabled={!isNew} onChange={(e) => set('id', slug(e.target.value))} />
            </Field>
          </div>

          <Field label="Products" hint="The name as comments write it (lowercase, no spaces), and its site">
            <div className="space-y-2">
              {form.products.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className={input}
                    placeholder="e.g. clipwise"
                    value={p.id}
                    onChange={(e) => {
                      const products = form.products.slice()
                      products[i] = { ...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') }
                      set('products', products)
                    }}
                  />
                  <input
                    className={input}
                    placeholder="e.g. clipwise.com"
                    value={p.site}
                    onChange={(e) => {
                      const products = form.products.slice()
                      products[i] = { ...p, site: e.target.value }
                      set('products', products)
                    }}
                  />
                  {form.products.length > 1 && (
                    <button
                      onClick={() => set('products', form.products.filter((_, j) => j !== i))}
                      className="text-zinc-500 hover:text-red-300 px-2"
                      title="Remove this product"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => set('products', [...form.products, { id: '', site: '' }])}
                className="text-xs text-zinc-300 border border-zinc-700 rounded px-2 py-1 hover:bg-zinc-800"
              >
                + product
              </button>
            </div>
          </Field>

          <Field
            label="What the product does"
            hint="A few sentences in your own words. Used only to draft the fields below."
          >
            <textarea className={input} rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <button
            onClick={() => void draft()}
            disabled={busy !== ''}
            className="text-sm text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 rounded-lg px-3 py-1.5"
          >
            {busy === 'draft' ? 'Drafting…' : '✨ Draft everything below with AI'}
          </button>

          {/* ── 2. how its comments read ── */}
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <div className="text-xs uppercase tracking-wide text-zinc-500">How its comments sound</div>
            <Field label="What the product is" hint='One sentence containing "{PRODUCT}"'>
              <textarea className={area} rows={2} value={form.what} onChange={(e) => set('what', e.target.value)} />
            </Field>
            <Field label="Who is commenting" hint="The ordinary person, the words they never use, the phrasings they would">
              <textarea className={area} rows={5} value={form.voice} onChange={(e) => set('voice', e.target.value)} />
            </Field>
            <Field label="Angle on general videos" hint="This genre has one audience; every link is served this angle">
              <textarea className={area} rows={5} value={form.angleGeneric} onChange={(e) => set('angleGeneric', e.target.value)} />
            </Field>
            <Field label="Angle on a rival's video (optional)" hint="Blank uses the general angle">
              <textarea className={area} rows={4} value={form.angleCompetitors} onChange={(e) => set('angleCompetitors', e.target.value)} />
            </Field>
            <Field label="Advert words to reject" hint="One regular expression per line">
              <textarea className={area} rows={4} value={form.jargon} onChange={(e) => set('jargon', e.target.value)} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Question aside">
                <input className={input} value={form.curiousAside} onChange={(e) => set('curiousAside', e.target.value)} />
              </Field>
              <Field label="Recommend phrasings">
                <input className={input} value={form.recommendVerbs} onChange={(e) => set('recommendVerbs', e.target.value)} />
              </Field>
              <Field label="Plain fact">
                <input className={input} value={form.plainFact} onChange={(e) => set('plainFact', e.target.value)} />
              </Field>
            </div>
          </div>

          {/* ── 3. base comments ── */}
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Base comments</div>
            {form.products.filter((p) => p.id.trim()).map((p) => (
              <Field
                key={p.id}
                label={`${p.id} — one per line`}
                hint="Every generated comment is a rewrite of one of these; at least 5"
              >
                <textarea
                  className={area}
                  rows={6}
                  value={form.seeds[p.id] ?? ''}
                  onChange={(e) => set('seeds', { ...form.seeds, [p.id]: e.target.value })}
                />
              </Field>
            ))}
          </div>

          {/* ── 4. links, replies, promo ── */}
          <div className="border-t border-zinc-800 pt-4 space-y-3">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Links, replies and promo</div>
            <Field label="What a related video is about" hint='For "Mark unrelated" on Links to verify'>
              <textarea className={area} rows={3} value={form.relatedSubject} onChange={(e) => set('relatedSubject', e.target.value)} />
            </Field>
            <Field label="Related keywords" hint="A title containing one is always related; commas or lines">
              <textarea className={area} rows={2} value={form.relatedKeywords} onChange={(e) => set('relatedKeywords', e.target.value)} />
            </Field>
            <Field label="When a reply belongs under a comment">
              <textarea className={area} rows={2} value={form.replyRelevance} onChange={(e) => set('replyRelevance', e.target.value)} />
            </Field>
            <Field label="How a reply introduces the product" hint="One clause">
              <input className={input} value={form.replyMention} onChange={(e) => set('replyMention', e.target.value)} />
            </Field>
            <Field label="Promo caption brief" hint='Contains "{PRODUCT}"'>
              <textarea className={area} rows={3} value={form.promo} onChange={(e) => set('promo', e.target.value)} />
            </Field>
            <Field label="Search phrases" hint="One per line — the control center's Search tab starts from these">
              <textarea className={area} rows={5} value={form.searchPhrases} onChange={(e) => set('searchPhrases', e.target.value)} />
            </Field>
          </div>

          {problems.length > 0 && (
            <ul className="text-sm text-red-300 space-y-0.5 list-disc pl-5">
              {problems.map((p, i) => <li key={i}>{p}</li>)}
            </ul>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => void save()}
              disabled={busy !== ''}
              className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg px-3 py-1.5"
            >
              {busy === 'save' ? 'Saving…' : isNew ? 'Add genre' : 'Save changes'}
            </button>
            <button onClick={() => { setForm(null); setProblems([]) }} className="text-sm text-zinc-300 border border-zinc-700 rounded-lg px-3 py-1.5">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
