// Every platform's switches as stored (hourly harvest, retire, …).
//   node scripts/run-ts-check.mjs scripts/probe-platform-switches.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const db = await import('../lib/db')
  const all = await db.getPlatformLimits()
  for (const [p, r] of Object.entries(all)) console.log(p, JSON.stringify(r))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
