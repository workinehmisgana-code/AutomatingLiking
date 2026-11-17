// "Name inside the sentence": generate one batch for a product with the switch
// OFF and ON (nothing is saved) and print both, to compare.
//   node scripts/run-ts-check.mjs scripts/probe-in-sentence.ts [product] [category]
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const product = process.argv[2] || 'purifytext'
  const category = process.argv[3] || 'generic'
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const { callGroqForAudience, settingsFor } = await import('../lib/commentGen')
  const { COMMENTS } = await import('../lib/comments')
  const { band, style } = await settingsFor(product)
  const base = (COMMENTS[product] ?? []).slice(0, 14)
  console.log(`${product} / ${category} · stored style ${JSON.stringify(style)} · band ${band.min}-${band.max}`)
  for (const inSentence of [false, true]) {
    const out = await callGroqForAudience(product, category as never, base, band, { ...style, inSentence })
    console.log(`\n── name inside the sentence: ${inSentence ? 'ON' : 'off'} (${out.length})`)
    for (const c of out.slice(0, 10)) console.log('   ' + c)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
