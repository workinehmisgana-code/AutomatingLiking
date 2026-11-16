// Remove repeated topics from the Study helper related-prompt (an earlier run
// of study-helper-humanizer.ts appended its topics once per run). Keeps every
// distinct topic, in order, and the keywords as they are.
//   node scripts/run-ts-check.mjs scripts/fix-study-related-dupes.ts [--save]
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const store = await import('../lib/genreStore')
  await store.ensureGenreRegistry(true)
  const { relatedCriteria } = await import('../lib/prompts')
  const g = (await store.listCustomGenres()).find((x) => x.id === 'study-helper')
  if (!g) throw new Error('no study-helper genre')
  const { head, topics } = relatedCriteria('study-helper' as never)
  const seen = new Set<string>()
  const uniq = topics.filter((t) => {
    const k = t.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const list = uniq.length > 1 ? `${uniq.slice(0, -1).join(', ')}, or ${uniq[uniq.length - 1]}` : uniq.join('')
  const subject = head ? `about ${head}: ${list}` : list
  console.log('before:', g.copy.related.subject)
  console.log('after: ', subject)
  if (!process.argv.includes('--save')) {
    console.log('dry run — pass --save')
    process.exit(0)
  }
  const r = await store.saveGenreRelated('study-helper', subject, g.copy.related.keywords)
  console.log('ok' in r && r.ok ? 'saved' : JSON.stringify(r))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
