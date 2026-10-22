'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  isCommentVoice,
  productForms,
  productWords,
  TOP_LIST_BOUNDS,
  type CommentStyle,
  type CommentVoice,
  type LinkCategory,
  type Product,
  type TopListRank,
  type TopListSetting,
} from '@/lib/config'
import { buildAudiencePrompt } from '@/lib/prompts'
import LlmModelPicker from '@/components/LlmModelPicker'

/** One row of the measured list, as the settings endpoint returns it. */
interface TopRow {
  text: string
  /** Videos this comment is on, inside the window. */
  links: number
  /** Percent of servings that ended up on a link, or null if too few to judge. */
  ratio: number | null
  /** Times it was handed out in the window. */
  served: number
}

const RANK_LABEL: Record<TopListRank, string> = {
  links: 'most links',
  ratio: 'best ratio',
  balanced: 'reach + ratio',
}

const RANK_HINT: Record<TopListRank, string> = {
  links: 'The comments on the most videos. Rewards what has been handed out a lot, whether or not it lands often.',
  ratio: 'The comments that land most often per serving. Rewards a high hit rate even on few servings — so anything served under 20 times is left out.',
  balanced: 'Half reach, half hit rate, each scored against the best in the list. The middle answer: nothing wins on volume alone or on a lucky handful.',
}

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
  /** The voices this set is REBUILT from, in the order they were added. */
  voices: string[]
}

// Why a set would be built from more than one batch. Long enough to be worth
// naming rather than inlining into three copies of the same button.
const ADD_BATCH_HINT =
  'Generate another batch in the voice selected above and ADD it to this ' +
  "audience's set, keeping what is already there.\n\n" +
  'This is how a set gets a mix of voices: set a voice, Add, switch the voice, ' +
  'Add again. Duplicates are dropped, so adding twice on one voice does not ' +
  'double the set.\n\n' +
  'Regenerate replaces the set instead.'

// Why you would add to all three at once rather than one at a time.
const ADD_ALL_HINT =
  'Generate a batch in the voice selected below and ADD it to all three ' +
  'audience sets, keeping what is already there.\n\n' +
  'This is how every set gets a mix of voices: generate on one voice, switch ' +
  'the voice, press this. Duplicates are dropped, so pressing twice on one ' +
  'voice does not double anything.\n\n' +
  'Regenerate replaces the sets instead.'

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
 * The two-word spelling used for the preview — the generator's own table.
 *
 * It used to be a copy, on the grounds that the browser only needs an example.
 * The copy drifted: it held three products of seven, so the preview for the
 * other four showed the one-word spelling that is never actually sent.
 */
function splitPreview(product: string): string {
  return productWords(product)
}

export default function AdminProductComments({
  product,
  wordMin,
  wordMax,
  style,
  top,
  perCategory,
  products,
}: {
  product: string
  wordMin: number
  wordMax: number
  style: CommentStyle
  /** Serve the measured top list instead of the written bank, and how. */
  top: TopListSetting
  perCategory: AudienceSet[]
  /** Every product, with its set size and whether it is being served. */
  products: { id: string; count: number; active: boolean }[]
}) {
  const router = useRouter()
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  // Comment length band for THIS product. The generator asks for a spread of
  // lengths inside it and discards anything outside, so it takes effect on the
  // next regeneration rather than retroactively.
  const [min, setMin] = useState(String(wordMin))
  const [max, setMax] = useState(String(wordMax))
  const [savingBand, setSavingBand] = useState(false)
  const [savingStyle, setSavingStyle] = useState(false)
  // Writing style. Like the band, it applies on the NEXT regeneration - the
  // stored comments are not rewritten in place.
  const [emoji, setEmoji] = useState(style.emoji)
  const [splitBrand, setSplitBrand] = useState(style.splitBrand)
  // Still sent and still stored, so an older row round-trips unchanged; no
  // longer shown, because productMention() stopped honouring it.
  const [quoteBrand] = useState(style.quoteBrand)
  // Which of the three pitches the comments make.
  const [voice, setVoice] = useState<CommentVoice>(style.voice)
  // What the server currently holds, so an edited-but-unsaved box is visible.
  const [savedBand, setSavedBand] = useState({ min: wordMin, max: wordMax })

  // ── Serve the comments that measurably landed ──────────────────────────
  // Everything below is about the OTHER source of comments: not what was
  // written for this product, but which of its comments have actually been
  // reaching videos lately.
  const [topOn, setTopOn] = useState(top.enabled)
  const [topCount, setTopCount] = useState(String(top.count))
  const [topRank, setTopRank] = useState<TopListRank>(top.rank)
  const [topDays, setTopDays] = useState(String(top.days))
  const [savedTop, setSavedTop] = useState<TopListSetting>(top)
  const [topSaving, setTopSaving] = useState(false)
  const [topBusy, setTopBusy] = useState(false)
  const [topErr, setTopErr] = useState('')
  const [topList, setTopList] = useState<TopRow[] | null>(null)
  // The settings the list ON SCREEN was ranked by, which is not always what the
  // boxes say: changing a box does not re-rank anything until Preview or Save.
  // Labelling the list from the boxes would rename a list without reordering it.
  const [topListFor, setTopListFor] = useState<TopListSetting | null>(null)

  /**
   * Fetch the list the current boxes describe, WITHOUT saving them.
   *
   * The preview is the point: the whole setting is a judgement about which
   * ranking and which window give a list worth serving, and that cannot be
   * judged from four numbers. It is the same query the server serves from.
   */
  async function loadTopList(over?: Partial<TopListSetting>) {
    setTopBusy(true)
    setTopErr('')
    try {
      const q = new URLSearchParams({
        product,
        list: '1',
        count: String(over?.count ?? topCount),
        rank: String(over?.rank ?? topRank),
        days: String(over?.days ?? topDays),
      })
      const res = await fetch(`/api/admin/comments/settings?${q.toString()}`)
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? 'Failed')
      setTopList(Array.isArray(d?.list) ? d.list : [])
      if (d?.listFor) setTopListFor(d.listFor)
    } catch (e) {
      setTopErr(String(e))
      setTopList(null)
    } finally {
      setTopBusy(false)
    }
  }

  /** Persist the given keys and re-read the list from what was stored. */
  async function saveTop(patch: {
    topEnabled?: boolean
    topCount?: number
    topRank?: TopListRank
    topDays?: number
  }) {
    setTopSaving(true)
    setTopErr('')
    setErr('')
    try {
      const res = await fetch('/api/admin/comments/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The band and style go along unchanged: this endpoint saves the row,
        // and leaving them out would save the boxes' current text as the band.
        body: JSON.stringify({ product, min: savedBand.min, max: savedBand.max, ...patch }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error ?? 'Failed')
      if (d?.top) {
        // Show what was STORED, not what was typed: the server clamps.
        setSavedTop(d.top)
        setTopOn(!!d.top.enabled)
        setTopCount(String(d.top.count))
        setTopRank(d.top.rank)
        setTopDays(String(d.top.days))
      }
      if (Array.isArray(d?.list) && d.list.length > 0) {
        setTopList(d.list)
        setTopListFor(d.top)
      } else if (d?.top?.enabled) await loadTopList(d.top)
      setMsg(
        d?.top?.enabled
          ? `Serving the top ${d.top.count} by ${RANK_LABEL[d.top.rank as TopListRank]} from the last ${d.top.days} days ✓`
          : 'Back to the written comments below ✓'
      )
    } catch (e) {
      setTopErr(String(e))
    } finally {
      setTopSaving(false)
    }
  }

  // WHAT IS EDITED BUT NOT STORED, named one by one.
  //
  // This used to be a single sentence naming only the SAVED setting, which read
  // as though the ranking just chosen were already the one in force — pick
  // "best ratio" and the warning answered "reach + ratio", the value being
  // replaced. Naming both ends of each change is the whole fix.
  const topPending = [
    Number(topCount) !== savedTop.count ? `how many ${savedTop.count} → ${topCount}` : '',
    topRank !== savedTop.rank
      ? `ranked by ${RANK_LABEL[savedTop.rank]} → ${RANK_LABEL[topRank]}`
      : '',
    Number(topDays) !== savedTop.days ? `last days ${savedTop.days} → ${topDays}` : '',
  ].filter(Boolean)

  // Already on when the page opens? Then the list IS what is being served, and
  // it should be on screen without a click asking for it.
  useEffect(() => {
    if (top.enabled) void loadTopList(top)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product])

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
      // quoteBrand is no longer honoured, so there is nothing to put it into.
      if (isCommentVoice(d.voice)) setVoice(d.voice)
      return true
    } catch {
      setErr('Network error.')
      return false
    }
  }

  /**
   * Persist a style change the moment it is made.
   *
   * THIS WAS THE BUG. The voice selector and the two checkboxes only set local
   * state, and the only things that wrote them to the database were the button
   * labelled "Save range" and a regeneration. So changing the voice updated the
   * preview, looked like it had worked, and was gone on the next page load —
   * which is exactly "I cannot change the voice". Measured on the real rows: of
   * six products, one had a voice saved from this control.
   *
   * The band keeps its own explicit Save because it is two numbers being typed,
   * and saving on every keystroke would store "1" on the way to "14".
   */
  async function commitStyle(patch: {
    voice?: CommentVoice
    emoji?: boolean
    splitBrand?: boolean
  }) {
    setSavingStyle(true)
    setMsg('')
    setErr('')
    try {
      const res = await fetch('/api/admin/comments/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product,
          // The band goes along unchanged: the endpoint takes the whole settings
          // row, and leaving these out would reset it to the defaults.
          min: Number(min) || wordMin,
          max: Number(max) || wordMax,
          emoji: patch.emoji ?? emoji,
          splitBrand: patch.splitBrand ?? splitBrand,
          quoteBrand,
          voice: patch.voice ?? voice,
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(d?.error || 'Could not save the writing style.')
        return
      }
      // Show what the server stored, so a rejected value cannot sit on screen
      // looking saved.
      if (isCommentVoice(d.voice)) setVoice(d.voice)
      if (typeof d.emoji === 'boolean') setEmoji(d.emoji)
      if (typeof d.splitBrand === 'boolean') setSplitBrand(d.splitBrand)
      setMsg('Saved. It applies to the next regeneration.')
    } catch {
      setErr('Network error.')
    } finally {
      setSavingStyle(false)
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

  // ── The prompts, shown before generating ──────────────────────────────────
  //
  // One per audience, computed HERE from the switches as they stand, using the
  // same pure function the server sends to Groq (lib/commentPrompt imports
  // nothing but config). So changing the voice or the word range rewrites them
  // as you watch, with no round trip and no second copy of the wording to drift
  // out of step.
  const audiencePrompt = (category: string) =>
    buildAudiencePrompt(
      product as Product,
      category as LinkCategory,
      { min: Number(min) || wordMin, max: Number(max) || wordMax },
      { emoji, splitBrand, quoteBrand, voice }
    )

  // Which audience prompts are expanded. Collapsed by default: three of them
  // open at once would bury the comments they are about.
  const [audPromptOpen, setAudPromptOpen] = useState<Set<string>>(new Set())
  const toggleAudPrompt = (category: string) =>
    setAudPromptOpen((prev) => {
      const n = new Set(prev)
      if (n.has(category)) n.delete(category)
      else n.add(category)
      return n
    })

  // ── Dropping a comment you do not want ──────────────────────────────────────
  // Removed lines are remembered here and filtered out on the spot, so the list
  // does not sit there showing something that is already gone while the server
  // re-renders. Keyed by audience + text, because the same sentence can exist
  // in more than one set and only the one clicked should disappear.
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState('')
  // A newline separator, so a product's set and an audience's set never collide
  // on the same sentence — only the one actually clicked disappears.
  const dropKey = (text: string, category?: string) => `${category ?? ''}\n${text}`
  const isDropped = (text: string, category?: string) => dropped.has(dropKey(text, category))

  async function deleteComment(text: string, category: string) {
    if (deleting) return
    const ok = confirm(
      `Delete this comment?\n\n${text}\n\n` +
        'It is removed from the set users are served for this audience. Regenerating ' +
        'brings a fresh batch — this one will not come back unless the model writes it again.'
    )
    if (!ok) return
    setDeleting(dropKey(text, category))
    setErr('')
    setMsg('')
    try {
      const res = await fetch('/api/admin/comments', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, category, text }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Could not delete.'); return }
      if (!Number(d.removed)) {
        // The stored set has moved on — a regeneration landed between the page
        // rendering and the click. Saying so beats a silent no-op.
        setErr('That comment is no longer in the set — refreshing.')
        router.refresh()
        return
      }
      setDropped((prev) => new Set(prev).add(dropKey(text, category)))
      setMsg('Deleted.')
      router.refresh()
    } catch {
      setErr('Network error while deleting.')
    } finally {
      setDeleting('')
    }
  }

  // What a mention will look like under the current switches, so the effect is
  // visible before spending a regeneration to find out.
  const words = splitBrand ? splitPreview(product) : product
  // NO QUOTES, whatever the stored setting says — see productMention(). A name
  // in quotation marks is a name being announced, and the preview has to show
  // what will really be sent.
  const brand = words
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

  // Length spread of what is currently stored, across all three audiences —
  // there is nothing else stored, so this is the whole picture for the product.
  const storedComments = perCategory.flatMap((a) => a.comments)
  const lengths = storedComments.map((c) => c.trim().split(/\s+/).filter(Boolean).length)
  const spread = lengths.length
    ? { lo: Math.min(...lengths), hi: Math.max(...lengths),
        avg: Math.round((lengths.reduce((a, b) => a + b, 0) / lengths.length) * 10) / 10 }
    : null

  // '' = idle, 'all' = the three together, otherwise the category running.
  const [audBusy, setAudBusy] = useState('')

  /**
   * Regenerate one audience IN THE VOICE ON SCREEN.
   *
   * It used to rebuild from the set's recorded recipe, so setting the voice to
   * informational and pressing Regenerate produced questions — correct by the
   * rule and indefensible as behaviour. The recipe still protects a hand-built
   * mix from the nightly rebuild; it does not overrule the person pressing the
   * button with the dropdown in front of them.
   *
   * A mix of two or more voices is worth one question before it is replaced,
   * because rebuilding from one voice is how a mix gets lost.
   */
  async function regenerateAudience(category: string) {
    const set = perCategory.find((c) => c.category === category)
    const mix = (set?.voices ?? []).filter((v) => v !== voice)
    if (mix.length > 1 && !confirm(
      `This set is rebuilt from ${set?.voices.join(' + ')}.\n\n` +
      `Regenerate it in ${voice} alone? The mix is replaced, and later rebuilds ` +
      `use ${voice} until you add another voice.`
    )) return
    setAudBusy(category)
    setMsg('')
    setErr('')
    try {
      if (!(await commitBand())) return
      const res = await fetch('/api/admin/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, category, voices: [voice] }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Regeneration failed.'); return }
      setMsg(
        `${AUDIENCE[category]?.label ?? category}: wrote ${d.count ?? 0} ${voice} comments ✓`
      )
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
          // The voice on screen, for the same reason as the single-audience
          // button: this is a person pressing Regenerate, not the cron.
          body: JSON.stringify({ product, category, voices: [voice] }),
        })
        const d = await res.json().catch(() => ({}))
        if (res.ok) done += Number(d.count) || 0
        else { setErr(d?.error || `Failed on ${category}.`); break }
      }
      setMsg(`Wrote ${done} ${voice} comments across the three audiences ✓`)
      router.refresh()
    } catch {
      setErr('Network error.')
    } finally {
      setAudBusy('')
    }
  }

  /**
   * Add a batch of the current voice to ALL THREE audiences.
   *
   * The per-audience buttons exist for topping up one set; this is for the
   * normal case, where the aim is to mix a second voice through everything
   * users are served. Generate on one voice, switch the voice, press this, and
   * every audience ends up with both.
   *
   * Sequential for the same reason Regenerate is: three concurrent rewrites of
   * one product exhaust the Groq tokens-per-minute budget and the later ones
   * simply fail. A failure on one audience stops the run rather than carrying
   * on, so the message says which one and the rest are left as they were.
   */
  async function addBatchToAll() {
    setAudBusy('add-all')
    setMsg('')
    setErr('')
    const parts: string[] = []
    let total = 0
    try {
      if (!(await commitBand())) return
      for (const { category } of perCategory) {
        const label = AUDIENCE[category]?.label ?? category
        setMsg(`Adding a ${voice} batch to ${label}…`)
        const res = await fetch('/api/admin/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product, category, append: true }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setErr(d?.error || `Failed on ${label}.`); break }
        const added = Number(d.added) || 0
        total += added
        parts.push(`${label} +${added}`)
      }
      // Zero added is a real answer, not a failure: the voice has said
      // everything it has to say and the dedupe dropped the lot.
      setMsg(
        total === 0
          ? `Nothing new — every line this ${voice} batch produced was already there.`
          : `Added ${total} ${voice} comment(s) — ${parts.join(', ')} ✓`
      )
      router.refresh()
    } catch {
      setErr('Network error.')
    } finally {
      setAudBusy('')
    }
  }

  /**
   * Add another batch to ONE audience instead of replacing it.
   *
   * This is how a set gets a MIX of voices: set the voice, press Add, switch the
   * voice, press Add again. Regenerate still replaces, which is what you want
   * while tuning one voice and not what you want once it is right.
   *
   * The word range and style are saved first, exactly as Regenerate does — the
   * batch must be generated under the settings on screen, not the ones last
   * saved.
   */
  /**
   * Make this set rebuild from the voice selected above, and nothing else.
   *
   * WHAT THE RECIPE IS FOR, now that Regenerate overrules it. The nightly rebuild
   * has no dropdown to read, so it goes on making one batch per recorded voice —
   * which is what stops it flattening a mix somebody built with Add. This button
   * changes that record without generating anything, for the case where the
   * nightly job should follow the selection too.
   *
   * It used to be the only way to make the voice take effect at all: Regenerate
   * rebuilt from the recipe, so setting informational and pressing it produced
   * questions. Correct by the rule and indefensible as behaviour.
   */
  async function useOnlyVoice(category: string) {
    setAudBusy(category)
    setMsg('')
    setErr('')
    try {
      const res = await fetch('/api/admin/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, category, voices: [voice], recipeOnly: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(d?.error || 'Could not change the mix.')
        return
      }
      setMsg(
        `${AUDIENCE[category]?.label ?? category}: rebuilds from ${voice} alone from now on. ` +
          'Regenerate it to replace the comments already written.'
      )
      router.refresh()
    } catch {
      setErr('Network error.')
    } finally {
      setAudBusy('')
    }
  }

  /**
   * Take one voice out of a set's recipe.
   *
   * The comments it already contributed stay — they are indistinguishable from
   * the rest once written, and deleting by voice would need a provenance we do
   * not keep. This only stops the NEXT rebuild from making that batch again.
   */
  async function dropVoice(category: string, voice: string) {
    const set = perCategory.find((c) => c.category === category)
    if (!set) return
    const next = set.voices.filter((v) => v !== voice)
    if (next.length === 0) {
      setErr('A set needs at least one voice. Add another before removing this one.')
      return
    }
    setAudBusy(category)
    setMsg('')
    setErr('')
    try {
      const res = await fetch('/api/admin/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, category, voices: next, recipeOnly: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Could not change the mix.'); return }
      setMsg(
        `${AUDIENCE[category]?.label ?? category}: rebuilt from ${next.join(' + ')} from now on. ` +
          'The comments already written stay until the next regeneration.'
      )
      router.refresh()
    } catch {
      setErr('Network error.')
    } finally {
      setAudBusy('')
    }
  }

  async function addAudienceBatch(category: string) {
    setAudBusy(category)
    setMsg('')
    setErr('')
    try {
      if (!(await commitBand())) return
      const label = AUDIENCE[category]?.label ?? category
      setMsg(`Adding a ${voice} batch to ${label}…`)
      const res = await fetch('/api/admin/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product, category, append: true }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(d?.error || 'Could not add a batch.'); return }
      const added = Number(d.added) || 0
      const total = Number(d.total) || 0
      setMsg(
        added === 0
          ? `${label}: nothing new — every line this batch produced was already there (${total} total).`
          : `${label}: added ${added} ${voice} comment(s); ${total} in the set now.`
      )
      router.refresh()
    } catch {
      setErr('Network error.')
    } finally {
      setAudBusy('')
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <span>Comments ·</span>
          <select
            value={product}
            onChange={(e) => router.push(`/admin/comments/${e.target.value}`)}
            title="Switch to another product's comments"
            className="bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1 text-lg font-bold text-emerald-400 focus:outline-none focus:border-emerald-500 cursor-pointer"
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} ({p.count})
                {p.active ? '' : ' · off'}
              </option>
            ))}
          </select>
        </h1>
        <Link
          href="/admin"
          className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Admin
        </Link>
      </div>

      <p className="text-sm text-zinc-500 mb-4 leading-relaxed">
        Comments are written per AUDIENCE. Each link is sorted into one on the Links page and is
        served a comment from the matching set below — so a comment aimed at someone shopping for
        a rival humanizer never lands under a video about beating Turnitin. A link with no
        category of its own is served <span className="text-zinc-300">Competitors</span>, the
        audience most of the pool belongs to.
      </p>

      <div className="mb-4">
        <LlmModelPicker />
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
              {savingBand ? 'Saving…' : 'Save word range'}
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
            // 'Quote the brand' used to be here and is gone: quoting is no longer
            // applied, so the switch could only lie about what would be sent.
          ] as const).map(([label, value, set, hint]) => (
            <label key={label} className="flex items-center gap-1.5 text-xs text-zinc-300" title={hint}>
              <input
                type="checkbox"
                checked={value}
                disabled={savingStyle}
                onChange={(e) => {
                  set(e.target.checked)
                  // Same bug as the voice: a checkbox that only moved local state
                  // looked saved and was not.
                  void commitStyle(
                    label === 'Emoji'
                      ? { emoji: e.target.checked }
                      : { splitBrand: e.target.checked }
                  )
                }}
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
              onChange={(e) => {
                const v = e.target.value as CommentVoice
                setVoice(v)
                void commitStyle({ voice: v })
              }}
              disabled={savingStyle}
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
            {storedComments.length} comment{storedComments.length === 1 ? '' : 's'}.
          </p>
        )}
      </div>

      {/* Serve the comments that measurably landed, instead of the written ones */}
      <div
        className={`rounded-xl border p-3 mb-4 ${
          topOn ? 'border-emerald-700/60 bg-emerald-950/20' : 'border-zinc-800 bg-zinc-900/40'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <label className="flex items-center gap-2 text-sm font-semibold text-white cursor-pointer">
              <input
                type="checkbox"
                checked={topOn}
                disabled={topSaving}
                onChange={(e) => {
                  setTopOn(e.target.checked)
                  void saveTop({ topEnabled: e.target.checked })
                }}
                className="accent-emerald-500"
              />
              Serve the top comments
            </label>
            <p className="text-xs text-zinc-500 mt-1 max-w-md leading-relaxed">
              On, every click for <span className="text-zinc-300">{product}</span> is answered
              from the list below — this product&apos;s own comments that have been landing on
              videos lately — instead of from the written sets further down.{' '}
              <span className="text-amber-400/80">
                The written sets are per audience and this list is not
              </span>
              , so this trades matching the comment to the video for serving what measurably
              works.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-zinc-400">
              How many
              <input
                type="number"
                min={TOP_LIST_BOUNDS.count.min}
                max={TOP_LIST_BOUNDS.count.max}
                value={topCount}
                onChange={(e) => setTopCount(e.target.value)}
                title={`The top N to draw from, ${TOP_LIST_BOUNDS.count.min}-${TOP_LIST_BOUNDS.count.max}. Fewer means the same lines repeat under more videos.`}
                className="mt-1 block w-20 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </label>
            <label className="text-xs text-zinc-400">
              Ranked by
              <select
                value={topRank}
                onChange={(e) => setTopRank(e.target.value as TopListRank)}
                title={Object.values(RANK_HINT).join('\n\n')}
                className="mt-1 block bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              >
                <option value="balanced">reach + ratio</option>
                <option value="ratio">best ratio</option>
                <option value="links">most links</option>
              </select>
            </label>
            <label className="text-xs text-zinc-400">
              Last days
              <input
                type="number"
                min={TOP_LIST_BOUNDS.days.min}
                max={TOP_LIST_BOUNDS.days.max}
                value={topDays}
                onChange={(e) => setTopDays(e.target.value)}
                title="Measured on comments POSTED inside this window. A short window follows what is working now; a long one has more to rank on."
                className="mt-1 block w-20 bg-zinc-900 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </label>
            <button
              onClick={() =>
                void saveTop({
                  topCount: Number(topCount),
                  topRank,
                  topDays: Number(topDays),
                })
              }
              disabled={topSaving || topBusy}
              className="text-sm text-white bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              {topSaving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => void loadTopList()}
              disabled={topBusy || topSaving}
              title="Show the list these boxes describe, without saving them"
              className="text-sm text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              {topBusy ? 'Measuring…' : 'Preview'}
            </button>
          </div>
        </div>
        <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">{RANK_HINT[topRank]}</p>
        {topPending.length > 0 && (
          <p className="text-[11px] text-amber-400/80 mt-1">
            Not saved: {topPending.join(', ')}.{' '}
            {topOn
              ? `Clicks are still answered from the top ${savedTop.count} by ` +
                `${RANK_LABEL[savedTop.rank]} over ${savedTop.days} days.`
              : 'The switch above is off, so clicks come from the written sets below either way.'}{' '}
            Preview ranks the boxes without saving them; Save makes them the stored setting.
          </p>
        )}
        {topErr && <p className="text-xs text-red-400 mt-2">{topErr}</p>}

        {(topOn || topList !== null) && (
          <div className="mt-3 pt-3 border-t border-zinc-800">
            <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
              <div className="text-xs font-semibold text-white">
                {topList === null || topListFor === null
                  ? 'The list'
                  : `Top ${topList.length} by ${RANK_LABEL[topListFor.rank]} · last ` +
                    `${topListFor.days} days`}
              </div>
              <div className="text-[11px] text-zinc-600">
                links = videos it is on · ratio = how often a serving lands · served = times
                handed out
              </div>
            </div>
            {topBusy && <p className="text-xs text-zinc-500">Measuring…</p>}
            {!topBusy && topList !== null && topList.length === 0 && (
              <p className="text-xs text-amber-400/80 leading-relaxed">
                Nothing measured for {product} in this window
                {(topListFor?.rank ?? topRank) !== 'links'
                  ? ' with at least 20 servings to judge a ratio on'
                  : ''}
                .
                Clicks fall back to the written sets below, so nobody is left without a comment
                — widen the window, or scan more links, to fill this.
              </p>
            )}
            {!topBusy && topList !== null && topList.length > 0 && (
              <ol className="space-y-1.5">
                {topList.map((r, i) => (
                  <li
                    key={r.text}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                  >
                    <span className="w-5 shrink-0 text-right text-zinc-600 tabular-nums">
                      {i + 1}
                    </span>
                    <span className="flex-1 min-w-0 text-zinc-200 break-words">{r.text}</span>
                    <span className="basis-full sm:basis-auto shrink-0 pl-7 sm:pl-0 text-zinc-500 tabular-nums">
                      {r.links} link{r.links === 1 ? '' : 's'} ·{' '}
                      <span className={r.ratio === null ? '' : 'text-emerald-400/70'}>
                        {r.ratio === null ? 'ratio —' : `${r.ratio}%`}
                      </span>{' '}
                      · {r.served} served
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <button
          onClick={regenerateAllAudiences}
          disabled={audBusy !== ''}
          title="Saves the word range, then REPLACES all three audience sets for this product"
          className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
        >
          {audBusy === 'all' ? 'Regenerating…' : 'Regenerate all comments'}
        </button>
        <button
          onClick={addBatchToAll}
          disabled={audBusy !== ''}
          title={ADD_ALL_HINT}
          className="text-sm text-zinc-100 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
        >
          {audBusy === 'add-all' ? 'Adding…' : `+ Add a ${voice} batch to all three`}
        </button>
        {msg && <span className="text-sm text-emerald-400">{msg}</span>}
        {err && <span className="text-sm text-red-400">{err}</span>}
      </div>

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
          <span className="text-zinc-300">These are the comments users actually get.</span> Each
          link is categorised on the Links page and is served a comment from the matching set — so
          a comment written for someone worried about Turnitin never lands under a video that has
          nothing to do with detection. A link with no category of its own is served{' '}
          <span className="text-zinc-300">Competitors</span>, the audience most of the pool belongs
          to. A set that has never been generated falls back to the main set above, so no link is
          ever left without something to copy.
        </p>

        <div className="space-y-4">
          {perCategory.map(({ category, comments: list, generatedAt: at, voices }) => {
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
                    title="REPLACES this audience's set, in the voice selected above"
                    className="text-xs text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-2.5 py-1 disabled:opacity-40"
                  >
                    {audBusy === category ? 'Regenerating…' : list.length ? 'Regenerate' : 'Generate'}
                  </button>
                  {list.length > 0 && (
                    <button
                      onClick={() => addAudienceBatch(category)}
                      disabled={audBusy !== ''}
                      title={ADD_BATCH_HINT}
                      className="text-xs text-zinc-300 border border-zinc-700 hover:bg-zinc-800 rounded-lg px-2.5 py-1 disabled:opacity-40"
                    >
                      + Add a {voice} batch
                    </button>
                  )}
                </div>
                {/* THE RECIPE. Regeneration — the button above and the nightly
                    job — rebuilds from exactly these, one batch each. Without
                    showing it, an admin has no way to know what tonight will
                    produce, and a mix they built silently became one voice. */}
                <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-zinc-800">
                  <span className="text-[11px] text-zinc-500">
                    rebuilt from{voices.length > 1 ? ` ${voices.length} voices` : ''}:
                  </span>
                  {(voices.length ? voices : [voice]).map((v) => (
                    <span
                      key={v}
                      className={`text-[11px] rounded px-1.5 py-0.5 border ${
                        voices.length
                          ? 'text-teal-200 bg-teal-600/15 border-teal-600/40'
                          : 'text-zinc-400 bg-zinc-800 border-zinc-700'
                      }`}
                      title={
                        voices.length
                          ? 'Every regeneration makes a batch in this voice and merges them.'
                          : 'No mix recorded yet, so a regeneration uses the voice selected above. Add a batch to start a mix.'
                      }
                    >
                      {v}
                      {voices.length > 1 && (
                        <button
                          type="button"
                          onClick={() => dropVoice(category, v)}
                          disabled={audBusy !== ''}
                          title={`Stop rebuilding ${v} into this set`}
                          className="ml-1 text-zinc-500 hover:text-rose-400 disabled:opacity-40"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {!voices.length && (
                    <span className="text-[11px] text-zinc-600">(current voice, not a saved mix)</span>
                  )}
                  {/* WHAT THE RECIPE STILL DECIDES, now that Regenerate uses the
                      voice on screen: the NIGHTLY rebuild, which has no dropdown to
                      read. Saying which is which is the difference between a
                      mechanism and a surprise. */}
                  {voices.length > 0 && !voices.includes(voice) && (
                    <>
                      <span className="text-[11px] text-zinc-500">
                        — the nightly rebuild uses that; Regenerate below uses {voice}
                      </span>
                      <button
                        type="button"
                        onClick={() => void useOnlyVoice(category)}
                        disabled={audBusy !== ''}
                        title={`Record ${voice} as this set's recipe, so the nightly rebuild uses it too. Writes no comments — the ones already here stay until you regenerate.`}
                        className="text-[11px] text-white bg-teal-600 hover:bg-teal-500 rounded px-1.5 py-0.5 disabled:opacity-40"
                      >
                        use {voice} nightly too
                      </button>
                    </>
                  )}
                </div>
                <div className="border-b border-zinc-800">
                  <button
                    type="button"
                    onClick={() => toggleAudPrompt(category)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-zinc-800/40 transition-colors"
                  >
                    <span className="text-[11px] text-zinc-400">
                      ✎ Prompt for this audience
                      <span className="text-zinc-600 ml-1.5">
                        built from the settings above
                      </span>
                    </span>
                    <span className="text-zinc-500 text-[11px]">
                      {audPromptOpen.has(category) ? '▴' : '▾'}
                    </span>
                  </button>
                  {audPromptOpen.has(category) && (
                    <div className="px-3 pb-3">
                      <p className="text-[11px] text-zinc-500 mb-1.5 leading-relaxed">
                        Exactly what is sent when you regenerate this set. Read-only — the
                        audience angle is fixed; the rest follows the settings above, so
                        changing the voice or word range rewrites this too.
                      </p>
                      <textarea
                        readOnly
                        value={audiencePrompt(category)}
                        spellCheck={false}
                        rows={12}
                        className="w-full text-[11px] font-mono leading-relaxed text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-2 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard?.writeText(audiencePrompt(category))}
                        className="mt-1.5 text-[11px] text-zinc-400 hover:text-zinc-100 border border-zinc-700 rounded px-2 py-0.5"
                      >
                        copy
                      </button>
                    </div>
                  )}
                </div>
                {list.length === 0 ? (
                  <div className="p-4 text-xs text-zinc-600">
                    Nothing generated for this audience yet — links in it are served another
                    active product's comments for the same audience. If no product has any,
                    they get nothing at all. Press Generate.
                  </div>
                ) : (
                  <ol className="divide-y divide-zinc-800/60">
                    {list.filter((c) => !isDropped(c, category)).map((c, i) => (
                      <li key={c + i} className="flex items-baseline gap-3 px-3 py-1.5">
                        <span className="w-6 shrink-0 text-right text-[11px] text-zinc-600 tabular-nums">
                          {i + 1}
                        </span>
                        <span className="flex-1 text-sm text-zinc-200">{c}</span>
                        <span className="shrink-0 text-[11px] text-zinc-600 tabular-nums">
                          {c.trim().split(/\s+/).filter(Boolean).length}w
                        </span>
                        <button
                          type="button"
                          onClick={() => void deleteComment(c, category)}
                          disabled={deleting !== ''}
                          title="Delete this comment from this audience's set"
                          className="shrink-0 text-[11px] text-zinc-600 hover:text-rose-400 disabled:opacity-40 transition-colors"
                        >
                          {deleting === dropKey(c, category) ? '…' : '✕'}
                        </button>
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
