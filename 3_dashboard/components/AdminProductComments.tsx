'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { isCommentVoice, type CommentStyle, type CommentVoice, type Product } from '@/lib/config'
import { buildSystemPrompt } from '@/lib/commentPrompt'

function fmtWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

interface AudienceSet {
  category: string
  comments: string[]
  generatedAt: string | null
}

// Labels and one-line reminders of who each set is written for. Kept beside the
// UI rather than imported so the wording can differ from the model's prompt.
const AUDIENCE: Record<string, { label: string; hint: string; tone: string }> = {
  competitors: {
    label: 'Competitors',
    hint: 'video promotes a rival humanizer — the viewer is already shopping',
    tone: 'text-rose-300',
  },
  ai_detector: {
    label: 'AI detector',
    hint: 'video is about Turnitin / GPTZero / getting flagged',
    tone: 'text-amber-300',
  },
  generic: {
    label: 'Generic',
    hint: 'study or essay content with no tool angle',
    tone: 'text-zinc-300',
  },
}

/**
 * The two-word spelling used for the preview.
 *
 * A copy of PRODUCT_WORDS rather than an import: this runs in the browser and
 * only needs to render an example, while the real mention is applied by the
 * generator on the server, where the mapping actually lives.
 */
const SPLIT_PREVIEW: Record<string, string> = {
  purifytext: 'purify text',
  acoustictext: 'acoustic text',
  prohumanly: 'pro humanly',
}

function splitPreview(product: string): string {
  return SPLIT_PREVIEW[product] ?? product
}

export default function AdminProductComments({
  product,
  comments,
  generatedAt,
  isGenerated,
  wordMin,
  wordMax,
  style,
  perCategory,
}: {
  product: string
  comments: string[]
  generatedAt: string | null
  isGenerated: boolean
  wordMin: number
  wordMax: number
  style: CommentStyle
  perCategory: AudienceSet[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  // Comment length band for THIS product. The generator asks for a spread of
  // lengths inside it and discards anything outside, so it takes effect on the
  // next regeneration rather than retroactively.
  const [min, setMin] = useState(String(wordMin))
  const [max, setMax] = useState(String(wordMax))
  const [savingBand, setSavingBand] = useState(false)
  // Writing style. Like the band, it applies on the NEXT regeneration - the
  // stored comments are not rewritten in place.
  const [emoji, setEmoji] = useState(style.emoji)
  const [splitBrand, setSplitBrand] = useState(style.splitBrand)
  const [quoteBrand, setQuoteBrand] = useState(style.quoteBrand)
  // Which of the three pitches the comments make.
  const [voice, setVoice] = useState<CommentVoice>(style.voice)
  // What the server currently holds, so an edited-but-unsaved box is visible.
  const [savedBand, setSavedBand] = useState({ min: wordMin, max: wordMax })

  // Persist whatever is in the boxes and return the band the server actually
  // stored (it clamps and orders). Every Regenerate calls this first: the range
  // used to need its own Save click, so typing a range and hitting Regenerate
  // silently rebuilt the comments at the OLD length and looked like the setting
  // did nothing.
  async function commitBand(): Promise<boolean> {
    try {
      const res = await fetch('/api/admin/comments/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product,
          min: Number(min),
          max: Number(max),
          emoji,
          splitBrand,
          quoteBrand,
          voice,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Could not save the word range.'); return false }
      setMin(String(d.min))
      setMax(String(d.max))
      setSavedBand({ min: Number(d.min), max: Number(d.max) })
      if (typeof d.emoji === 'boolean') setEmoji(d.emoji)
      if (typeof d.splitBrand === 'boolean') setSplitBrand(d.splitBrand)
      if (typeof d.quoteBrand === 'boolean') setQuoteBrand(d.quoteBrand)
      if (isCommentVoice(d.voice)) setVoice(d.voice)
      return true
    } catch {
      setErr('Network error.')
      return false
    }
  }

  async function saveBand() {
    setSavingBand(true)
    setMsg('')
    setErr('')
    const ok = await commitBand()
    if (ok) setMsg('Word range saved. Regenerate to apply it.')
    setSavingBand(false)
  }

  // ── The prompt, editable before generating ────────────────────────────────
  //
  // The built prompt is computed HERE, from the switches as they stand, using
  // the same function the server sends to Groq (lib/commentPrompt is pure and
  // imports nothing but config). So changing the voice or the word range
  // rewrites the box as you watch, with no round trip and no second copy of the
  // wording to drift out of step.
  //
  // Only the SAVED override comes from the server, because only that is stored.
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptSaved, setPromptSaved] = useState<string | null>(null)
  const [promptBusy, setPromptBusy] = useState(false)
  const [promptLoaded, setPromptLoaded] = useState(false)
  // What is in the box. null means "following the built prompt" — the state
  // that lets the settings drive it. Typing sets it, which stops the following.
  const [promptEdit, setPromptEdit] = useState<string | null>(null)

  const promptBuilt = useMemo(
    () =>
      buildSystemPrompt(
        product as Product,
        { min: Number(min) || wordMin, max: Number(max) || wordMax },
        { emoji, splitBrand, quoteBrand, voice }
      ),
    [product, min, max, wordMin, wordMax, emoji, splitBrand, quoteBrand, voice]
  )

  // What the box shows: an unsaved edit, else the saved override, else live.
  const promptText = promptEdit ?? promptSaved ?? promptBuilt
  // A saved override does NOT follow the settings — it is the admin's own text.
  // Say so rather than silently ignoring the switches they are moving.
  const overrideStale = !promptEdit && !!promptSaved && promptSaved.trim() !== promptBuilt.trim()

  async function loadPrompt() {
    try {
      const res = await fetch(`/api/admin/comments/prompt?product=${encodeURIComponent(product)}`)
      const d = await res.json()
      if (!res.ok) { setErr(d?.error || 'Could not load the prompt.'); return }
      setPromptSaved(d.saved ?? null)
      setPromptLoaded(true)
    } catch {
      setErr('Network error.')
    }
  }

  async function savePrompt(text: string) {
    setPromptBusy(true)
    setMsg('')
    setErr('')
    try {
      const res = await fetch('/api/admin/comments/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, prompt: text }),
      })
      const d = await res.json()
      if (!res.ok) { setErr(d?.error || 'Could not save the prompt.'); return }
      setPromptSaved(d.saved ?? null)
      setPromptEdit(null)
      setMsg(d.saved ? 'Prompt saved. Regenerate to use it.' : 'Back to the built-in prompt.')
    } catch {
      setErr('Network error.')
    } finally {
      setPromptBusy(false)
    }
  }

  // What a mention will look like under the current switches, so the effect is
  // visible before spending a regeneration to find out.
  const words = splitBrand ? splitPreview(product) : product
  const brand = quoteBrand ? `“${words}”` : words
  // Show the VOICE as well as the mention: the two switches together are what
  // a comment will actually read like, and the mention alone hid the bigger of
  // the two changes.
  const preview =
    (voice === 'question'
      ? `why does nothing else come back 0% like ${brand} does?`
      : voice === 'curious'
        ? `what made you switch to ${brand}? the flow reads really clean`
        : voice === 'recommendation'
          ? `i switched to ${brand} and mine passes now`
          : `${brand} rewrites ai text so detectors read it as human`) +
    (emoji ? ' 🙌' : '')

  // Length spread of what is currently stored, so the effect is visible.
  const lengths = comments.map((c) => c.trim().split(/\s+/).filter(Boolean).length)
  const spread = lengths.length
    ? { lo: Math.min(...lengths), hi: Math.max(...lengths),
        avg: Math.round((lengths.reduce((a, b) => a + b, 0) / lengths.length) * 10) / 10 }
    : null

  // '' = idle, 'all' = the three together, otherwise the category running.
  const [audBusy, setAudBusy] = useState('')

  async function regenerateAudience(category: string) {
    setAudBusy(category)
    setMsg('')
    setErr('')
    try {
      if (!(await commitBand())) return
      const res = await fetch('/api/admin/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, category }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Regeneration failed.'); return }
      setMsg(`${AUDIENCE[category]?.label ?? category}: wrote ${d.count ?? 0} comments ✓`)
      router.refresh()
    } catch {
      setErr('Network error.')
    } finally {
      setAudBusy('')
    }
  }

  // Sequential, not parallel: three concurrent rewrites of the same product hit
  // the Groq per-minute token limit and the later ones just fail.
  async function regenerateAllAudiences() {
    setAudBusy('all')
    setMsg('')
    setErr('')
    let done = 0
    try {
      if (!(await commitBand())) return
      for (const { category } of perCategory) {
        const res = await fetch('/api/admin/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product, category }),
        })
        const d = await res.json().catch(() => ({}))
        if (res.ok) done += Number(d.count) || 0
        else { setErr(d?.error || `Failed on ${category}.`); break }
      }
      setMsg(`Wrote ${done} comments across the three audiences ✓`)
      router.refresh()
    } catch {
      setErr('Network error.')
    } finally {
      setAudBusy('')
    }
  }

  // Regenerate EVERYTHING for this product: the neutral set the app falls back
  // to, then each audience set. Sequential, because three or four concurrent
  // rewrites of the same product hit the Groq per-minute token limit and the
  // later ones simply fail. The word range is saved first, so whatever is in
  // the boxes is the range all four calls use.
  async function regenerate() {
    setBusy(true)
    setMsg('')
    setErr('')
    try {
      if (!(await commitBand())) return

      setMsg('Rewriting the main set…')
      const res = await fetch('/api/admin/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Regeneration failed.'); return }
      const r = (d?.results?.[product] ?? {}) as { ok?: boolean; count?: number; error?: string }
      if (!r.ok) { setErr(r.error || 'Regeneration failed.'); return }

      // Each audience is its own request so one failure does not lose the rest,
      // and so no single serverless invocation has to hold four LLM calls.
      const done: string[] = [`main ${r.count ?? 0}`]
      const failed: string[] = []
      for (const { category } of perCategory) {
        const label = AUDIENCE[category]?.label ?? category
        setMsg(`Rewriting ${label}…`)
        try {
          const ar = await fetch('/api/admin/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product, category }),
          })
          const ad = await ar.json().catch(() => ({}))
          if (ar.ok) done.push(`${label} ${ad.count ?? 0}`)
          else failed.push(`${label}: ${ad?.error || 'failed'}`)
        } catch {
          failed.push(`${label}: network error`)
        }
      }

      setMsg(`Rewrote ${done.join(', ')} ✓`)
      if (failed.length) setErr(failed.join(' · '))
      // Re-run the server component so the freshly stored comments show.
      router.refresh()
    } catch {
      setErr('Network error.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white">
          Comments · <span className="text-emerald-400">{product}</span>
        </h1>
        <Link
          href="/admin"
          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Admin
        </Link>
      </div>

      <p className="text-sm text-zinc-500 mb-4">
        {isGenerated ? (
          <>
            {comments.length} AI-rewritten comments · last generated{' '}
            <span className="text-zinc-300">{fmtWhen(generatedAt)}</span>. These are what users
            assigned to <span className="text-zinc-300">{product}</span> see.
          </>
        ) : (
          <>
            Not generated yet — showing the {comments.length} original comments from{' '}
            <span className="text-zinc-300">lib/comments.ts</span>. Click Regenerate to create the
            short AI versions.
          </>
        )}
      </p>

      {/* The prompt, at the top, editable before generating. Collapsed by
          default: it is the thing you change least often and the longest thing
          on the page. */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 mb-4">
        <button
          type="button"
          onClick={() => {
            const next = !promptOpen
            setPromptOpen(next)
            if (next && !promptLoaded) void loadPrompt()
          }}
          className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left"
        >
          <span className="text-sm text-zinc-200">
            ✎ Prompt
            <span className="text-xs text-zinc-500 ml-2">
              {promptSaved ? 'edited' : 'built from the settings below'}
            </span>
          </span>
          <span className="text-zinc-500 text-xs">{promptOpen ? '▴' : '▾'}</span>
        </button>
        {promptOpen && (
          <div className="px-3 pb-3 space-y-2 border-t border-zinc-800 pt-3">
            <p className="text-[11px] text-zinc-500">
              What the model is told before it writes. While it is unedited this box
              follows the settings below — change the voice or the word range and the
              wording here changes with it. Typing in it stops that: a saved prompt
              REPLACES the built-in one entirely, and the settings then only shape the
              checks applied to what comes back (word range, brand spelling, the voice
              filters). Applies to the next Regenerate.
            </p>
            {overrideStale && (
              <p className="text-[11px] text-amber-400/90">
                The settings have moved on since this prompt was saved, and a saved prompt
                does not follow them. Reset to built-in to take the new wording.
              </p>
            )}
            <textarea
              value={promptText}
              onChange={(e) => setPromptEdit(e.target.value)}
              spellCheck={false}
              rows={14}
              className="w-full text-xs font-mono leading-relaxed text-zinc-200 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void savePrompt(promptText)}
                disabled={promptBusy || promptText.trim() === (promptSaved ?? '').trim()}
                className="text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg px-3 py-1.5"
              >
                {promptBusy ? 'Saving…' : 'Save prompt'}
              </button>
              <button
                type="button"
                onClick={() => { setPromptEdit(null); void savePrompt('') }}
                disabled={promptBusy || (!promptSaved && !promptEdit)}
                title="Throw the edit away and follow the settings again."
                className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 disabled:opacity-40 rounded-lg px-3 py-1.5"
              >
                Reset to built-in
              </button>
              <span className="text-[11px] text-zinc-600">
                {promptText.length.toLocaleString()} characters ·{' '}
                {promptEdit !== null
                  ? 'unsaved changes'
                  : promptSaved
                    ? 'saved prompt — not following the settings'
                    : 'following the settings'}
              </span>
            </div>
          </div>
        )}
      </div>


      {/* Comment length band */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 mb-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-white">Comment length</div>
            <p className="text-xs text-zinc-500 mt-0.5 max-w-md leading-relaxed">
              Generated comments must fall in this range, and the generator asks for a
              different length for each one so the batch is a real mix of short and long —
              not the same size repeated.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <label className="text-xs text-zinc-400">
              Min words
              <input
                type="number"
                min={1}
                max={60}
                value={min}
                onChange={(e) => setMin(e.target.value)}
                className="mt-1 block w-20 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </label>
            <label className="text-xs text-zinc-400">
              Max words
              <input
                type="number"
                min={1}
                max={60}
                value={max}
                onChange={(e) => setMax(e.target.value)}
                className="mt-1 block w-20 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </label>
            <button
              onClick={saveBand}
              disabled={savingBand}
              className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              {savingBand ? 'Saving…' : 'Save range'}
            </button>
          </div>
        </div>
        {/* Writing style. Three switches rather than free text: each one is a
            rule the generator can actually enforce after the model replies. */}
        <div className="flex flex-wrap items-center gap-4 mt-3 pt-3 border-t border-zinc-800">
          {([
            ['Emoji', emoji, setEmoji, 'End each comment with one upbeat emoji.'],
            [
              'Split the brand',
              splitBrand,
              setSplitBrand,
              `Write compound names as two words: ${product} becomes ${splitPreview(product)}.`,
            ],
            ['Quote the brand', quoteBrand, setQuoteBrand, 'Wrap the name in double quotes.'],
          ] as const).map(([label, value, set, hint]) => (
            <label key={label} className="flex items-center gap-1.5 text-xs text-zinc-300" title={hint}>
              <input
                type="checkbox"
                checked={value}
                onChange={(e) => set(e.target.checked)}
                className="accent-emerald-500"
              />
              {label}
            </label>
          ))}
          {/* The voice is a choice of three, not a switch: they are three
              different things for a comment to BE, and only one applies. */}
          <label className="flex items-center gap-1.5 text-xs text-zinc-300">
            voice
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value as CommentVoice)}
              title={[
                'question — the claim is ASSUMED and the comment asks about something else, so the reader draws the conclusion.',
                'curious — a question asked OF a person that wants a real answer, with the product folded in as a short aside.',
                'recommendation — a person saying what they use and why it worked.',
                'information — what the tool IS, stated flatly: no endorsement, no superlative, no first person.',
                'Applies to the NEXT regeneration; stored comments are not rewritten.',
              ].join('\n')}
              className="bg-zinc-950 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500"
            >
              <option value="question">question</option>
              <option value="recommendation">recommendation</option>
              <option value="curious">curious</option>
              <option value="informational">information</option>
            </select>
          </label>
          <span className="text-[11px] text-zinc-600">
            example: {preview}
          </span>
        </div>
        {(Number(min) !== savedBand.min || Number(max) !== savedBand.max) && (
          <p className="text-[11px] text-amber-400/80 mt-2">
            Not saved yet — stored range is {savedBand.min}–{savedBand.max}. Regenerating
            saves this range first, so you can just hit Regenerate.
          </p>
        )}
        {spread && (
          <p className="text-[11px] text-zinc-600 mt-2">
            Currently stored: {spread.lo}–{spread.hi} words (avg {spread.avg}) across{' '}
            {comments.length} comment{comments.length === 1 ? '' : 's'}.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <button
          onClick={regenerate}
          disabled={busy}
          title="Saves the word range, then rewrites the main set and all three audience sets for this product"
          className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
        >
          {busy ? 'Regenerating…' : 'Regenerate all comments'}
        </button>
        {msg && <span className="text-sm text-emerald-400">{msg}</span>}
        {err && <span className="text-sm text-red-400">{err}</span>}
      </div>

      {/* Comments list */}
      {comments.length === 0 ? (
        <p className="text-sm text-zinc-500 py-16 text-center">No comments for this product.</p>
      ) : (
        <div className="space-y-2">
          {comments.map((c, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5"
            >
              <span className="shrink-0 text-xs text-zinc-600 w-6 text-right tabular-nums">
                {i + 1}
              </span>
              <span className="flex-1 text-sm text-zinc-200 break-words">{c}</span>
              <span className="shrink-0 text-xs text-zinc-600 tabular-nums">
                {c.trim().split(/\s+/).filter(Boolean).length}w
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Audience sets — the comments the app serves per link category */}
      <div className="mt-8">
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <h2 className="text-sm font-semibold text-white">Comments by audience</h2>
          <button
            onClick={regenerateAllAudiences}
            disabled={audBusy !== ''}
            className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-2.5 py-1 disabled:opacity-40"
          >
            {audBusy === 'all' ? 'Regenerating…' : 'Regenerate all three'}
          </button>
        </div>
        <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
          Each link is categorised on the Links page, and the app copies a comment from the matching
          set — so a comment written for someone worried about Turnitin never lands under a video
          that has nothing to do with detection. A set that has never been generated falls back to
          the neutral comments above, so no link is ever left without something to copy.
        </p>

        <div className="space-y-4">
          {perCategory.map(({ category, comments: list, generatedAt: at }) => {
            const meta = AUDIENCE[category] ?? { label: category, hint: '', tone: 'text-zinc-300' }
            const lens = list.map((c) => c.trim().split(/\s+/).filter(Boolean).length)
            const band = lens.length
              ? `${Math.min(...lens)}–${Math.max(...lens)} words`
              : ''
            return (
              <div key={category} className="rounded-xl border border-zinc-800 bg-zinc-900/40">
                <div className="flex flex-wrap items-center gap-2 p-3 border-b border-zinc-800">
                  <span className={`text-sm font-medium ${meta.tone}`}>{meta.label}</span>
                  <span className="text-xs text-zinc-500">{meta.hint}</span>
                  <span className="text-xs text-zinc-600 ml-auto tabular-nums">
                    {list.length > 0
                      ? `${list.length} comment${list.length === 1 ? '' : 's'}${band ? ` · ${band}` : ''}${at ? ` · ${fmtWhen(at)}` : ''}`
                      : 'not generated yet'}
                  </span>
                  <button
                    onClick={() => regenerateAudience(category)}
                    disabled={audBusy !== ''}
                    className="text-xs text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-2.5 py-1 disabled:opacity-40"
                  >
                    {audBusy === category ? 'Regenerating…' : list.length ? 'Regenerate' : 'Generate'}
                  </button>
                </div>
                {list.length === 0 ? (
                  <div className="p-4 text-xs text-zinc-600">
                    Nothing generated for this audience yet — links in it currently get the neutral
                    comments above.
                  </div>
                ) : (
                  <ol className="divide-y divide-zinc-800/60">
                    {list.map((c, i) => (
                      <li key={i} className="flex items-baseline gap-3 px-3 py-1.5">
                        <span className="w-6 shrink-0 text-right text-[11px] text-zinc-600 tabular-nums">
                          {i + 1}
                        </span>
                        <span className="flex-1 text-sm text-zinc-200">{c}</span>
                        <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums">
                          {c.trim().split(/\s+/).filter(Boolean).length}w
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
