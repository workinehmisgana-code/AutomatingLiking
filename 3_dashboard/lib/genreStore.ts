// The server half of the genre registry: the stored list of added genres.
//
// One app_kv row ('custom_genres') holding the list as JSON — a handful of
// genres, read whole, written whole, so a table would add nothing but a schema.
// lib/genreRegistry.ts writes the list into the shared tables; this module
// decides when.

import { getAppState, setAppState } from './db'
import {
  applyGenreRegistry,
  completeCopy,
  validateGenre,
  type CustomGenre,
} from './genreRegistry'

const KEY = 'custom_genres'
/** How stale the applied list may get before a request reloads it. */
const MAX_AGE_MS = 60_000

let loadedAt = 0
let inflight: Promise<CustomGenre[]> | null = null

async function readStored(): Promise<CustomGenre[]> {
  const raw = await getAppState(KEY).catch(() => null)
  if (!raw) return []
  try {
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? (list as CustomGenre[]) : []
  } catch {
    return []
  }
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
    inflight = readStored()
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

/** The added genres, freshly read. */
export async function listCustomGenres(): Promise<CustomGenre[]> {
  return ensureGenreRegistry(true)
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
  const problems = validateGenre(genre, list, isNew)
  if (!isNew && !list.some((g) => g.id === genre.id)) problems.push(`There is no genre "${genre.id}" to edit.`)
  if (problems.length) return { ok: false, problems }
  const next = [...list.filter((g) => g.id !== genre.id), genre]
  await setAppState(KEY, JSON.stringify(next))
  return { ok: true, list: await ensureGenreRegistry(true) }
}

/**
 * Remove an added genre. Its links keep their genre field, and read as the
 * default genre from then on — see genreOfRow.
 */
export async function deleteCustomGenre(id: string): Promise<CustomGenre[]> {
  const list = await readStored()
  await setAppState(KEY, JSON.stringify(list.filter((g) => g.id !== id)))
  return ensureGenreRegistry(true)
}
