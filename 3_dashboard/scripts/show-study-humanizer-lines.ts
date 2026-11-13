// Print the study helpers' stored generic comments that talk about the humanizer.
//   node scripts/run-ts-check.mjs scripts/show-study-humanizer-lines.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const { getCategoryComments } = await import('../lib/db')
  for (const p of ['qoloclass', 'aterera', 'tintfolio']) {
    const list = (await getCategoryComments(p, 'generic'))?.comments ?? []
    const hum = list.filter((t) => /humani[sz]|turnitin|gptzero|flag|detector|0%|ai (essay|draft)|robotic/i.test(t))
    console.log(`\n${p}: ${hum.length} of ${list.length}`)
    for (const t of hum) console.log('  ' + t)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
