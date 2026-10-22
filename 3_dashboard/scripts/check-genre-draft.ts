// Live: does "✨ Draft everything with AI" produce a genre that passes validation?
//
//   node scripts/run-ts-check.mjs scripts/check-genre-draft.ts
//
// Calls the configured model once with the real draft prompt, maps the answer
// the way the Genres form does, and validates it. Saves nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

async function main() {
  const { llmChat } = await import('../lib/llm')
  const { GENRE_DRAFT_SYSTEM } = await import('../lib/prompts')
  const { completeCopy, validateGenre } = await import('../lib/genreRegistry')
  const { content, model } = await llmChat({
    messages: [
      { role: 'system', content: GENRE_DRAFT_SYSTEM },
      {
        role: 'user',
        content:
          'CATEGORY: Video editor\nPRODUCT(S): clipwise (clipwise.com)\n' +
          'WHAT THE PRODUCT DOES: You upload raw footage and it cuts it into a finished short video with captions and music.',
      },
    ],
    jsonObject: true,
    temperature: 0.6,
    maxTokens: 6000,
    timeoutMs: 55_000,
  })
  const d = JSON.parse(content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) as Record<string, unknown>
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '')
  const a = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).map(String) : [])
  const genre = {
    id: 'video-editor',
    label: 'Video editor',
    products: [{ id: 'clipwise', site: 'clipwise.com' }],
    copy: completeCopy({
      what: s('what'),
      voice: s('voice'),
      angles: { competitors: s('angleCompetitors'), ai_detector: s('angleGeneric'), generic: s('angleGeneric') },
      jargon: a('jargon'),
      replyRelevance: s('replyRelevance'),
      replyMention: s('replyMention'),
      promo: s('promo'),
      related: { subject: s('relatedSubject'), keywords: a('relatedKeywords') },
      voiceExamples: {
        curiousAside: s('voiceCuriousAside'),
        recommendVerbs: s('voiceRecommendVerbs'),
        plainFact: s('voicePlainFact'),
      },
    }),
    seeds: { clipwise: a('seeds').map((x) => x.replace(/\{PRODUCT\}/g, 'clipwise')) },
    searchPhrases: a('searchPhrases').join('\n'),
  }
  const problems = validateGenre(genre, [], true)
  const badRegex = genre.copy.jargon.filter((j) => { try { new RegExp(j, 'i'); return false } catch { return true } })
  console.log('model:', model)
  console.log('seeds:', genre.seeds.clipwise.length, '· keywords:', genre.copy.related.keywords.length, '· phrases:', a('searchPhrases').length, '· jargon:', genre.copy.jargon.length, badRegex.length ? `(${badRegex.length} invalid regex)` : '')
  console.log('what:', genre.copy.what)
  console.log('sample seed:', genre.seeds.clipwise[0])
  console.log(problems.length ? `problems:\n  ${problems.join('\n  ')}` : 'validates: ok')
  process.exit(problems.length || badRegex.length ? 1 : 0)
}
main()
