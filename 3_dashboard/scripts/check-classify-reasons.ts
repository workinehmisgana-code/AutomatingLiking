// "Mark unrelated" with reasons: judge a few staged titles per genre and print
// each verdict with its one-line reason. Live LLM call.
//   node scripts/run-ts-check.mjs scripts/check-classify-reasons.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const { pool } = await import('../lib/db')
  const { classifyWithReasonsByGenre } = await import('../lib/titleClassify')
  const { rows } = await pool.query<{ url: string; title: string; genre: string }>(
    `(SELECT url, title, genre FROM verify_link WHERE genre = 'study-helper' AND btrim(coalesce(title,'')) <> '' LIMIT 6)
     UNION ALL
     (SELECT url, title, genre FROM verify_link WHERE genre = 'website' AND btrim(coalesce(title,'')) <> '' LIMIT 6)`
  )
  const verdicts = await classifyWithReasonsByGenre(rows)
  let bad = 0
  const byUrl = new Map(verdicts.map((v) => [v.url, v]))
  for (const r of rows) {
    const v = byUrl.get(r.url)
    if (!v || !v.reason) bad++
    console.log(`[${r.genre}] ${v?.related ? 'RELATED  ' : 'unrelated'} ${r.title.slice(0, 70).replace(/\s+/g, ' ')}`)
    console.log(`            why: ${v?.reason ?? '(none)'}`)
  }
  console.log(bad ? `${bad} without a reason` : `all ${rows.length} have a reason`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
