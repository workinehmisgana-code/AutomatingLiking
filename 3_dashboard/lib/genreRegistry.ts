// Genres added in the admin, on top of the three built in.
//
// WHAT A GENRE NEEDS, and where each part lands:
//
//   id, label            GENRES and GENRE_LABELS (lib/config) — the genre switch,
//                        the genre mix, every genre filter and upload
//   products             PRODUCTS and PRODUCT_GENRE — serving, the comments pages,
//                        active products, pay split, the liker's product words
//   copy                 GENRE_COPY (lib/prompts) — what the product is, who the
//                        commenter is, the audience angles, the advert words to
//                        reject, how a reply introduces it, the promo brief, and
//                        what counts as RELATED for "Mark unrelated"
//   seeds                COMMENTS (lib/comments) — the comments every generated
//                        set is rewritten from; with none, nothing is generated
//   searchPhrases        the control center's search phrases for the genre
//
// HOW IT IS APPLIED: those tables are plain objects and arrays, read
// synchronously by about thirty modules on the server and in the browser.
// Rather than teach each of them to wait for a database, the stored list is
// written INTO them — at server start (instrumentation.ts), after every save,
// and in the browser from the root layout — so a module that reads GENRES sees
// the added genres exactly as it sees the built-in ones.
//
// PURE: no database, no network. The browser imports this. lib/genreStore.ts is
// the server half that reads and writes the stored list.

import { BUILTIN_GENRES, GENRES, GENRE_LABELS, PRODUCTS, PRODUCT_GENRE } from './config'
import { GENRE_COPY, type GenreCopy } from './prompts'
import { COMMENTS } from './comments'

export interface CustomProduct {
  /** Lowercase, letters and digits only — the name comments say, e.g. "slidera". */
  id: string
  /** The site, e.g. "slidera.com". Shown to the admin; the model is told it. */
  site: string
}

export interface CustomGenre {
  /** Lowercase letters, digits and dashes, e.g. "video-editor". Never changes. */
  id: string
  /** What the admin sees, e.g. "Video editor". */
  label: string
  products: CustomProduct[]
  copy: GenreCopy
  /** Base comments per product id. A product with none generates nothing. */
  seeds: Record<string, string[]>
  /** One search phrase per line, for the control center. */
  searchPhrases: string
}

/** Genre ids that may not be reused: the built-in three. */
export const RESERVED_GENRE_IDS: readonly string[] = BUILTIN_GENRES

const BUILTIN_PRODUCTS = [...PRODUCTS]

/** The genres applied last time, so a re-apply removes what was deleted. */
let applied: CustomGenre[] = []

// ── ONE LIST FOR THE WHOLE PROCESS ──────────────────────────────────────
//
// The server holds SEVERAL copies of lib/config: instrumentation, the page
// layouts and the API routes are bundled separately, and each bundle gets its
// own GENRES array. Applying the list to one copy left the others on the three
// built-in genres — which is how the genre-mix route silently dropped a Study
// helper share on save (its GENRES had no such genre), and how an upload or a
// worker feed would have read a study-helper link as humanizer.
//
// So every copy of this module registers its applier on globalThis, which the
// whole process shares; an apply anywhere runs all of them, and a copy loaded
// later applies the last list the moment it loads.
type RegistryGlobal = typeof globalThis & {
  __genreList?: CustomGenre[]
  __genreAppliers?: Set<(list: CustomGenre[]) => void>
}
const shared = globalThis as RegistryGlobal
const appliers = (shared.__genreAppliers ??= new Set())

/**
 * Write the added genres into the shared tables — in EVERY bundle's copy of
 * them (see above).
 *
 * IDEMPOTENT and complete: every call first takes back what the previous call
 * added and then adds this list, so a deleted genre or a renamed product does
 * not linger. The built-in genres and products are never touched.
 */
export function applyGenreRegistry(list: CustomGenre[]): void {
  shared.__genreList = list
  appliers.add(applyHere)
  appliers.forEach((apply) => apply(list))
}

/** applyGenreRegistry for THIS copy of the tables only. */
function applyHere(list: CustomGenre[]): void {
  for (const g of applied) {
    const gi = GENRES.indexOf(g.id)
    if (gi >= 0 && !(BUILTIN_GENRES as readonly string[]).includes(g.id)) GENRES.splice(gi, 1)
    delete GENRE_LABELS[g.id]
    delete (GENRE_COPY as Record<string, GenreCopy>)[g.id]
    for (const p of g.products) {
      if (BUILTIN_PRODUCTS.includes(p.id)) continue
      const pi = PRODUCTS.indexOf(p.id)
      if (pi >= 0) PRODUCTS.splice(pi, 1)
      delete PRODUCT_GENRE[p.id]
      delete (COMMENTS as Record<string, string[]>)[p.id]
    }
  }
  const clean = list.filter(
    (g) => g && g.id && !(BUILTIN_GENRES as readonly string[]).includes(g.id)
  )
  for (const g of clean) {
    if (!GENRES.includes(g.id)) GENRES.push(g.id)
    GENRE_LABELS[g.id] = g.label || g.id
    ;(GENRE_COPY as Record<string, GenreCopy>)[g.id] = g.copy
    for (const p of g.products) {
      // A built-in product cannot be moved into another genre from here.
      if (!p.id || BUILTIN_PRODUCTS.includes(p.id)) continue
      if (!PRODUCTS.includes(p.id)) PRODUCTS.push(p.id)
      PRODUCT_GENRE[p.id] = g.id
      ;(COMMENTS as Record<string, string[]>)[p.id] = g.seeds?.[p.id] ?? []
    }
  }
  applied = clean
}

// This copy joins the process-wide list on load, and catches up with it.
appliers.add(applyHere)
if (shared.__genreList) applyHere(shared.__genreList)

/** The genres currently applied (the added ones only). */
export function appliedGenres(): CustomGenre[] {
  return applied
}

/** The site of an added product, when it has one. */
export function siteOfProduct(product: string): string | null {
  for (const g of applied) {
    const p = g.products.find((x) => x.id === product)
    if (p) return p.site || null
  }
  return null
}

/**
 * Check a genre before it is saved. Returns the problems, empty when it is
 * complete. Everything required is required because something downstream has
 * nothing to fall back on without it.
 */
export function validateGenre(g: CustomGenre, others: CustomGenre[], isNew: boolean): string[] {
  const out: string[] = []
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(g.id || '')) {
    out.push('The id must be 2–31 lowercase letters, digits or dashes, starting with a letter.')
  }
  if ((BUILTIN_GENRES as readonly string[]).includes(g.id)) out.push(`"${g.id}" is a built-in genre.`)
  if (isNew && others.some((o) => o.id === g.id)) out.push(`A genre called "${g.id}" already exists.`)
  if (!g.label?.trim()) out.push('Give the genre a name.')
  if (!g.products?.length) out.push('Add at least one product.')
  const taken = new Set([
    ...BUILTIN_PRODUCTS,
    ...others.filter((o) => o.id !== g.id).flatMap((o) => o.products.map((p) => p.id)),
  ])
  const seen = new Set<string>()
  for (const p of g.products ?? []) {
    if (!/^[a-z][a-z0-9]{1,30}$/.test(p.id || '')) {
      out.push(`Product "${p.id}": use lowercase letters and digits only (the name comments say).`)
    }
    if (taken.has(p.id)) out.push(`Product "${p.id}" already belongs to another genre.`)
    if (seen.has(p.id)) out.push(`Product "${p.id}" is listed twice.`)
    seen.add(p.id)
    if ((g.seeds?.[p.id] ?? []).filter((s) => s.trim()).length < 5) {
      out.push(`Product "${p.id}" needs at least 5 base comments — every generated comment is a rewrite of one.`)
    }
  }
  const c = g.copy
  const need: [string, string | undefined][] = [
    ['What the product is', c?.what],
    ['Who is commenting (voice)', c?.voice],
    ['The comment angle (generic audience)', c?.angles?.generic],
    ['What counts as related (subject)', c?.related?.subject],
    ['How a reply introduces it', c?.replyMention],
    ['When a reply belongs under a comment', c?.replyRelevance],
    ['Promo caption brief', c?.promo],
  ]
  for (const [label, v] of need) if (!v?.trim()) out.push(`${label} is required.`)
  if (c?.what && !c.what.includes('{PRODUCT}')) out.push('"What the product is" must contain {PRODUCT}.')
  if (!c?.related?.keywords?.length) out.push('Give at least one related keyword.')
  return out
}

/**
 * Fill the parts of the copy nobody needs to write by hand.
 *
 * Added genres use one audience ('generic', like website and slides — the
 * classifier is humanizer-only), so the other two angles point at it, and the
 * voice examples default to plain wording built from the product description.
 */
export function completeCopy(c: Partial<GenreCopy>): GenreCopy {
  const generic = c.angles?.generic ?? ''
  return {
    what: c.what ?? '',
    voice: c.voice ?? '',
    angles: {
      competitors: c.angles?.competitors?.trim() || generic,
      ai_detector: generic,
      generic,
    },
    jargon: (c.jargon ?? []).filter((x) => x.trim()),
    replyRelevance: c.replyRelevance ?? '',
    replyMention: c.replyMention ?? '',
    promo: c.promo ?? '',
    related: {
      subject: c.related?.subject ?? '',
      keywords: (c.related?.keywords ?? [])
        .map((k) => k.toLowerCase().replace(/[^a-z0-9#]/g, ''))
        .filter(Boolean),
    },
    voiceExamples: {
      curiousAside: c.voiceExamples?.curiousAside || '"…? it worked first time for me"',
      recommendVerbs: c.voiceExamples?.recommendVerbs || '"i use", "i switched to", "works for me"',
      plainFact: c.voiceExamples?.plainFact || (c.what ?? '').replace(/"\{PRODUCT\}"\s*/g, 'it '),
    },
  }
}
