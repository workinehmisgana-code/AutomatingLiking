// Runs once when a server instance starts, before it handles a request.
//
// Applies the genres added in the admin (lib/genreStore.ts) so the very first
// request already sees them, and re-reads the list every minute so a genre saved
// on one serverless instance reaches the others without a redeploy.
//
// In this exact shape — the import inside `if (NEXT_RUNTIME === 'nodejs')` — so
// the edge build drops it: the store reaches the database through pg, which
// needs Node's fs and crypto.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startGenreRegistry } = await import('./instrumentation-node')
    await startGenreRegistry()
  }
}
