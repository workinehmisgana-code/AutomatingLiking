// What one "Mark unrelated" press does to a 500-row page: the whole page in one
// request, judged by classifyWithReasonsByGenre (100-title calls, all at once,
// numbered answers, skipped titles asked again). Times it and checks every
// title got a verdict, over several runs, and how stable the verdicts are.
//   node scripts/run-ts-check.mjs scripts/probe-classify-onebatch.ts [N] [genre] [runs]
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const n = Number(process.argv[2]) || 500
  const genre = process.argv[3] || 'humanizer'
  const runs = Number(process.argv[4]) || 3
  const { pool } = await import('../lib/db')
  const { classifyWithReasonsByGenre } = await import('../lib/titleClassify')
  const { rows } = await pool.query<{ url: string; title: string }>(
    `SELECT url, title FROM verify_link WHERE coalesce(genre,'humanizer') = $1
       AND btrim(coalesce(title,'')) <> '' ORDER BY added_at DESC LIMIT $2`, [genre, n])
  const items = rows.map((r) => ({ ...r, genre }))
  console.log(`${items.length} titles (${genre})`)
  const results: Map<string, boolean>[] = []
  for (let k = 1; k <= runs; k++) {
    const t0 = Date.now()
    try {
      const v = await classifyWithReasonsByGenre(items)
      const answered = v.filter((x) => x.reason !== 'The model gave no answer for this title').length
      console.log(`run ${k}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${answered}/${items.length} answered, ` +
        `${v.filter((x) => x.related).length} related`)
      results.push(new Map(v.map((x) => [x.url, x.related])))
    } catch (e) {
      console.log(`run ${k}: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)} s — ${String(e).slice(0, 200)}`)
    }
  }
  for (let k = 1; k < results.length; k++) {
    const same = items.filter((it) => results[0].get(it.url) === results[k].get(it.url)).length
    console.log(`run 1 vs run ${k + 1}: same verdict on ${same}/${items.length}`)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
