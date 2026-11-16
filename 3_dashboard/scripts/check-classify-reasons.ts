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
  const { relatedCriteria } = await import('../lib/prompts')
  for (const g of ['study-helper', 'website']) {
    const c = relatedCriteria(g as never)
    console.log(`\n${g} related-prompt — about ${c.head || '(no headline)'}:`)
    c.topics.forEach((t, i) => console.log(`  ${i + 1}. ${t}`))
  }
  console.log('')
  let bad = 0
  const byUrl = new Map(verdicts.map((v) => [v.url, v]))
  for (const r of rows) {
    const v = byUrl.get(r.url)
    if (!v || !v.reason) bad++
    // A related verdict must name the rule it followed.
    if (v && v.related && !v.ruleText) bad++
    const rule = !v ? '' : v.rule === 'topic' ? `topic ${v.ruleNo}: "${v.ruleText}"`
      : v.rule === 'keyword' ? `keyword "${v.ruleText}"` : 'no topic'
    console.log(`[${r.genre}] ${v?.related ? 'RELATED  ' : 'unrelated'} ${r.title.slice(0, 60).replace(/\s+/g, ' ')}`)
    console.log(`            rule: ${rule} — ${v?.reason ?? '(none)'}`)
  }
  console.log(bad ? `${bad} without a reason` : `all ${rows.length} have a reason`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
