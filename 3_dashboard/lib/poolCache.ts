// Read the pool once a minute instead of once a request.
//
// WHAT THIS IS FOR, measured on the live database before it existed:
//
//   20.5 BILLION rows read by sequential scans
//     blocked_link   74,238 full scans  ×  ~100k rows  =  7.40 billion
//     clicked_link   79,057 full scans  ×   ~73k rows  =  5.75 billion
//     link_category  21,174 full scans                 =  3.08 billion
//     link_title     16,607 full scans                 =  2.35 billion
//
// The database is 368 MB. Shipping 1.38 TB out of it in a month means reading the
// whole thing about 3,750 times over, and that egress was 58% of the bill — with
// the compute charge on top of it, because an instance being handed a hundred
// full-table scans a minute never suspends.
//
// The cause was structural rather than careless: a dozen loaders each read one
// whole table (`SELECT url FROM blocked_link`), the link pool is assembled from
// them in JavaScript, and BOTH the worker feed and every admin links view call
// that assembly on every request. Nothing was cached anywhere — no
// `unstable_cache`, no `revalidate`, and every route is `force-dynamic`.
//
// WHY A CACHE IS THE RIGHT ANSWER HERE, and not a workaround. These tables are
// written by a scraper, a nightly categoriser and an admin pressing buttons —
// minutes to hours apart. They are read several times a second. A reader that
// re-derives the same 257 MB for every request is not fresher in any way anybody
// can observe; it is the same answer, bought again.
//
// TWO PROPERTIES IT MUST HAVE, and a plain `let cache = ...` has neither:
//
//   SINGLE FLIGHT. Twenty requests arriving on a cold entry must make ONE query,
//   not twenty. That is exactly when the load is worst, so a cache that only
//   helps after the first result is the least useful shape.
//
//   INVALIDATION ON WRITE. An admin who blocks a link and sees it still listed
//   will press the button again. Time-based expiry alone cannot promise that, so
//   the writers drop the entries they invalidate and the next read rebuilds.
//
// PER INSTANCE, NOT SHARED. Serverless gives each warm instance its own memory,
// so the saving is "one build per instance per TTL" rather than one globally.
// With a handful of instances that is still a ~50-100x cut, and it needs no
// Redis, no new failure mode and no key to rotate.

interface Entry<T> {
  value?: T
  at: number
  /** The in-flight read, so concurrent callers wait on one query. */
  inflight?: Promise<T>
}

const store = new Map<string, Entry<unknown>>()

/** Cleared caches, for the check script and the admin's own sanity. */
export const cacheStats = { hits: 0, misses: 0, invalidations: 0 }

/**
 * Memoise a whole-table read for `ttlMs`, with one query per cold entry.
 *
 * Errors are never cached: a failed read leaves nothing behind, so the next
 * caller tries again rather than being handed the same failure for a minute.
 */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const hit = store.get(key) as Entry<T> | undefined
  if (hit?.inflight) return hit.inflight
  if (hit && hit.value !== undefined && now - hit.at < ttlMs) {
    cacheStats.hits++
    return Promise.resolve(hit.value)
  }
  cacheStats.misses++
  const inflight = fn()
    .then((value) => {
      store.set(key, { value, at: Date.now() })
      return value
    })
    .catch((e) => {
      // Drop the placeholder so the failure is not served to anybody else.
      store.delete(key)
      throw e
    })
  store.set(key, { at: now, inflight, value: hit?.value })
  return inflight
}

/**
 * Forget one key, or every key starting with a prefix.
 *
 * Called by the writers. Cheap enough to be generous with: dropping an entry
 * costs one rebuild, keeping a stale one costs somebody's trust in the page.
 */
export function invalidate(prefix: string): void {
  for (const k of Array.from(store.keys())) {
    if (k === prefix || k.startsWith(prefix)) {
      store.delete(k)
      cacheStats.invalidations++
    }
  }
}

/** Everything. For a write that could touch anything (a pool import, a reset). */
export function invalidateAll(): void {
  cacheStats.invalidations += store.size
  store.clear()
}

/**
 * How long each kind of answer may be reused.
 *
 * Chosen by how fast the underlying table actually changes and what a stale read
 * would cost, not by a round number:
 *
 *   pool     titles, categories, bios, stats — written by the scraper and the
 *            nightly categoriser. Minutes of staleness is invisible.
 *   blocked  an admin blocking a link wants it gone from the next page load, so
 *            this is short AND invalidated on write.
 *   clicks   changes on every click, and is used for retirement thresholds and
 *            ordering. A minute behind moves nothing anybody can see.
 *   scan     comment-scan coverage, rewritten by a scan run in progress.
 */
export const TTL = {
  pool: 5 * 60_000,
  blocked: 60_000,
  clicks: 60_000,
  scan: 2 * 60_000,
  build: 30_000,
} as const
