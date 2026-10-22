// The Node half of instrumentation.ts: apply the added genres, then keep them fresh.
import { ensureGenreRegistry } from './lib/genreStore'

export async function startGenreRegistry(): Promise<void> {
  await ensureGenreRegistry(true).catch(() => {})
  const t = setInterval(() => {
    ensureGenreRegistry().catch(() => {})
  }, 60_000)
  // Never keep a process alive just for this.
  ;(t as { unref?: () => void }).unref?.()
}
