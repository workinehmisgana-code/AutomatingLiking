// The server half of the genre registry: the stored list of added genres.
//
// One app_kv row ('custom_genres') holding the list as JSON — a handful of
// genres, read whole, written whole, so a table would add nothing but a schema.
// lib/genreRegistry.ts writes the list into the shared tables; this module
// decides when.
//
// A second row ('builtin_genre_products') holds the products added to a
// BUILT-IN genre — a new humanizer, say. They are applied through the same
// registry, as entries marked addsToBuiltin (see extraProductsAsGenres), so
// they reach every bundle and the browser exactly as an added genre does.

import { getAppState, setAppState } from './db'
import { PRODUCTS } from './config'
import {
  applyGenreRegistry,
  completeCopy,
  extraProductsAsGenres,
  validateExtraProduct,
  validateGenre,
  type CustomGenre,
  type ExtraProduct,
} from './genreRegistry'

const KEY = 'custom_genres'
const EXTRA_KEY = 'builtin_genre_products'
/** How stale the applied list may get before a request reloads it. */
const MAX_AGE_MS = 60_000

let loadedAt = 0
let inflight: Promise<CustomGenre[]> | null = null

async function readJsonList<T>(key: string): Promise<T[]> {
  const raw = await getAppState(key).catch(() => null)
  if (!raw) return []
  try {
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? (list as T[]) : []
  } catch {
    return []
  }
}

/** The added genres alone, as stored. */
const readStored = () => readJsonList<CustomGenre>(KEY)
/** The products added to built-in genres, as stored. */
const readExtras = () => readJsonList<ExtraProduct>(EXTRA_KEY)

/** Everything the registry applies: added genres, then added products. */
async function readAll(): Promise<CustomGenre[]> {
  const [genres, extras] = await Promise.all([readStored(), readExtras()])
  return [...genres, ...extraProductsAsGenres(extras)]
}

/**
 * Make sure the added genres are applied and no older than a minute.
 *
 * Called at server start (instrumentation.ts) and by the requests that most
 * need to be current — the admin layout, the root layout, the genre switch.
 * Other serverless instances pick a change up within MAX_AGE_MS of their next
 * such request. Never throws: a database blip leaves the last list in force.
 */
export async function ensureGenreRegistry(force = false): Promise<CustomGenre[]> {
  if (!force && Date.now() - loadedAt < MAX_AGE_MS) return currentList
  if (!inflight) {
    inflight = readAll()
      .then((list) => {
        applyGenreRegistry(list)
        currentList = list
        loadedAt = Date.now()
        return list
      })
      .catch(() => currentList)
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}
let currentList: CustomGenre[] = []

/** The added genres, freshly read (not the products added to built-in ones). */
export async function listCustomGenres(): Promise<CustomGenre[]> {
  return (await ensureGenreRegistry(true)).filter((g) => !g.addsToBuiltin)
}

/** The products added to built-in genres, freshly read. */
export async function listExtraProducts(): Promise<ExtraProduct[]> {
  await ensureGenreRegistry(true)
  return readExtras()
}

/**
 * Add a product to a built-in genre (Admin → Genres → Humanizer → Add product).
 * Returns the problems when it is incomplete (nothing is saved then), or the
 * stored list.
 */
export async function saveExtraProduct(
  input: Partial<ExtraProduct>
): Promise<{ ok: true; list: ExtraProduct[] } | { ok: false; problems: string[] }> {
  const extras = await readExtras()
  const x: ExtraProduct = {
    id: String(input.id ?? '').trim().toLowerCase(),
    genre: String(input.genre ?? '').trim(),
    site: String(input.site ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    words: String(input.words ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
    note: String(input.note ?? '').trim(),
    seeds: (Array.isArray(input.seeds) ? input.seeds : [])
      .map((t) => String(t).trim())
      .filter(Boolean),
  }
  await ensureGenreRegistry(true)
  // Every name in use anywhere: PRODUCTS holds the built-in ones and every
  // added one, this product included if it is being re-saved — so it is left
  // out, which lets a product be edited without tripping over itself.
  const taken = new Set(PRODUCTS.filter((p) => p !== x.id || !extras.some((e) => e.id === x.id)))
  const problems = validateExtraProduct(x, taken)
  if (problems.length) return { ok: false, problems }
  const next = [...extras.filter((e) => e.id !== x.id), x]
  await setAppState(EXTRA_KEY, JSON.stringify(next))
  await ensureGenreRegistry(true)
  return { ok: true, list: next }
}

/** Remove a product added to a built-in genre. The built-in ones cannot be. */
export async function deleteExtraProduct(id: string): Promise<ExtraProduct[]> {
  const extras = await readExtras()
  const next = extras.filter((e) => e.id !== id)
  await setAppState(EXTRA_KEY, JSON.stringify(next))
  await ensureGenreRegistry(true)
  return next
}

/**
 * Add a genre, or replace one with the same id. Returns the problems when it is
 * incomplete (nothing is saved then), or the stored list.
 */
export async function saveCustomGenre(
  input: CustomGenre,
  isNew: boolean
): Promise<{ ok: true; list: CustomGenre[] } | { ok: false; problems: string[] }> {
  const list = await readStored()
  const genre: CustomGenre = {
    id: String(input.id ?? '').trim().toLowerCase(),
    label: String(input.label ?? '').trim(),
    products: (input.products ?? []).map((p) => ({
      id: String(p.id ?? '').trim().toLowerCase(),
      site: String(p.site ?? '').trim(),
    })),
    copy: completeCopy(input.copy ?? {}),
    seeds: Object.fromEntries(
      Object.entries(input.seeds ?? {}).map(([k, v]) => [
        k.trim().toLowerCase(),
        (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean),
      ])
    ),
    searchPhrases: String(input.searchPhrases ?? '').trim(),
  }
  // The products added to built-in genres count as taken names too.
  const problems = validateGenre(genre, [...list, ...extraProductsAsGenres(await readExtras())], isNew)
  if (!isNew && !list.some((g) => g.id === genre.id)) problems.push(`There is no genre "${genre.id}" to edit.`)
  if (problems.length) return { ok: false, problems }
  const next = [...list.filter((g) => g.id !== genre.id), genre]
  await setAppState(KEY, JSON.stringify(next))
  return { ok: true, list: await listCustomGenres() }
}

/**
 * Change only what counts as RELATED for an added genre — the subject the
 * "Mark unrelated" question asks about, and the keywords that make a title
 * related whatever the model says. Edited from the Links to verify page, next
 * to the button it steers; the rest of the genre is left exactly as stored.
 *
 * Keywords are normalised the way titles are matched (lib/titleClassify:
 * lowercase, letters and digits only), so "study tips" is stored as
 * "studytips" — stored with the space it could never match anything.
 */
export async function saveGenreRelated(
  id: string,
  subject: string,
  keywords: string[]
): Promise<{ ok: true; related: { subject: string; keywords: string[] } } | { ok: false; error: string }> {
  const list = await readStored()
  const g = list.find((x) => x.id === id)
  if (!g) return { ok: false, error: `"${id}" is not an added genre, so it is not stored in the database.` }
  const s = subject.trim().replace(/\s+/g, ' ')
  const k = Array.from(
    new Set(keywords.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean))
  )
  if (!s) return { ok: false, error: 'Say what a related video is about.' }
  if (k.length === 0) return { ok: false, error: 'Give at least one related keyword.' }
  const related = { subject: s, keywords: k }
  g.copy = { ...g.copy, related }
  await setAppState(KEY, JSON.stringify(list))
  await ensureGenreRegistry(true)
  return { ok: true, related }
}

/**
 * Remove an added genre. Its links keep their genre field, and read as the
 * default genre from then on — see genreOfRow.
 */
export async function deleteCustomGenre(id: string): Promise<CustomGenre[]> {
  const list = await readStored()
  await setAppState(KEY, JSON.stringify(list.filter((g) => g.id !== id)))
  return listCustomGenres()
}
