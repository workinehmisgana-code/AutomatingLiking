// Print every genre (built-in and added) with its products and seed counts.
//   node scripts/run-ts-check.mjs scripts/list-genres.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const store = await import('../lib/genreStore')
  await store.ensureGenreRegistry(true)
  const cfg = await import('../lib/config')
  for (const g of cfg.GENRES) {
    console.log(`${g} (${cfg.GENRE_LABELS[g] ?? g}): ${cfg.productsInGenre(g).join(', ')}`)
  }
  const custom = await store.listCustomGenres()
  for (const g of custom) {
    console.log(`  custom ${g.id}: ${g.products.map((p) => `${p.id}[${g.seeds[p.id]?.length ?? 0} seeds, site ${p.site || '-'}]`).join(', ')}`)
  }
  const extras = await store.listExtraProducts()
  for (const x of extras) console.log(`  extra ${x.id} in ${x.genre}: ${x.seeds.length} seeds`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
