// The bigger Gemini batches, live: the related check (100 a call, in
// parallel), the audience categoriser (100 a call), reply drafts (30 a call)
// and comment generation (the whole bank in one call). Nothing is saved.
//   node scripts/run-ts-check.mjs scripts/probe-big-batches.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const secs = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)} s`

async function main(): Promise<void> {
  await (await import('../lib/genreStore')).ensureGenreRegistry(true)
  const { pool } = await import('../lib/db')
  const { llmTakesBigBatches } = await import('../lib/llm')
  console.log('chosen model takes big batches:', await llmTakesBigBatches())

  // ── 1. related check, 300 titles ──
  const { rows } = await pool.query<{ url: string; title: string; bio: string | null }>(
    `SELECT url, title, bio FROM verify_link WHERE coalesce(genre,'humanizer') = 'humanizer'
       AND btrim(coalesce(title,'')) <> '' ORDER BY added_at DESC LIMIT 300`)
  const { classifyRelated, classifyWithReasonsByGenre } = await import('../lib/titleClassify')
  let t0 = Date.now()
  const rel = await classifyRelated(rows, 'humanizer' as never)
  console.log(`\n1. related check: ${rows.length} titles in ${secs(t0)} -> ${rel.length} related`)
  // Against the with-reasons verdicts (numbered, measured stable): do they agree?
  const v = await classifyWithReasonsByGenre(rows.map((r) => ({ ...r, genre: 'humanizer' })))
  const relSet = new Set(rel)
  const agree = v.filter((x) => x.rule !== 'unanswered' && x.related === relSet.has(x.url)).length
  console.log(`   agrees with the with-reasons verdicts on ${agree}/${v.filter((x) => x.rule !== 'unanswered').length}`)

  // ── 2. categoriser, 100 links ──
  const { categorizeChunk } = await import('../lib/linkCategory')
  const items = rows.slice(0, 100).map((r) => ({ title: r.title, bio: r.bio ?? '' }))
  t0 = Date.now()
  const cats = await categorizeChunk(items as never)
  const dist: Record<string, number> = {}
  for (const c of cats) dist[c] = (dist[c] ?? 0) + 1
  console.log(`\n2. categoriser: ${items.length} links in ${secs(t0)} -> ${JSON.stringify(dist)}`)
  for (let i = 0; i < 4; i++) console.log(`   ${cats[i].padEnd(12)} ${items[i].title.slice(0, 70).replace(/\s+/g, ' ')}`)

  // ── 3. reply drafts, 30 comments ──
  const { draftReplies } = await import('../lib/replyGen')
  const sample = [
    'how do i stop turnitin flagging my essay', 'my teacher says my essay is ai but i wrote it',
    'gptzero said 98% ai on my own work', 'which humanizer actually works', 'this is so relatable lol',
    'does anyone know a tool to make chatgpt sound human', 'i got a zero for ai detection',
    'is quillbot enough to pass', 'the detectors are so unfair', 'need help with my essay due tomorrow',
  ]
  const targets = Array.from({ length: 30 }, (_, i) => ({
    url: `https://www.tiktok.com/@x/video/${7000000000000000000 + i}`,
    topText: sample[i % sample.length] + (i >= 10 ? ` (${i})` : ''),
    topUser: null,
  }))
  t0 = Date.now()
  const r = await draftReplies(targets as never, undefined, 'humanizer')
  console.log(`\n3. replies: ${targets.length} comments in ${secs(t0)} -> ${r.drafts.length} drafts, ${r.skips.length} skipped`)
  // Each reply must answer ITS comment: show a few pairs.
  for (const d of r.drafts.slice(0, 4)) console.log(`   "${d.topText}"\n      -> ${d.reply}`)

  // ── 4. comment generation: the whole bank ──
  const { callGroqForAudience, settingsFor } = await import('../lib/commentGen')
  const { COMMENTS } = await import('../lib/comments')
  const product = 'acoustictext'
  const { band, style } = await settingsFor(product)
  const bank = COMMENTS[product] ?? []
  t0 = Date.now()
  const out = await callGroqForAudience(product, 'generic' as never, bank.slice(0, 120), band, style)
  console.log(`\n4. comment generation: ${product}, ${Math.min(120, bank.length)} base comments in one call, ${secs(t0)} -> ${out.length} usable`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
