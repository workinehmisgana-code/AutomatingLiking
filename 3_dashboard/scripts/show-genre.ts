// Print one added genre in full (copy, seeds, words, notes).
//   node scripts/run-ts-check.mjs scripts/show-genre.ts study-helper
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const id = process.argv[2]
  const store = await import('../lib/genreStore')
  const g = (await store.listCustomGenres()).find((x) => x.id === id)
  console.log(JSON.stringify(g, null, 2))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
