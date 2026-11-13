// cohumanizer's base comments: written as if "co humanizer" were the CONCEPT —
// the kind of tool you run AI text through — not a brand being plugged. Every
// generated cohumanizer comment is a rewrite of one of these.
//
//   node scripts/run-ts-check.mjs scripts/cohumanizer-seeds.ts            (dry run)
//   node scripts/run-ts-check.mjs scripts/cohumanizer-seeds.ts --save     (save + regenerate)
import { readFileSync } from 'fs'
import { join } from 'path'

function loadEnv(): void {
  const text = readFileSync(join(process.cwd(), '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

export const SEEDS = [
  'the trick is running it through a co humanizer after chatgpt',
  'a co humanizer is what makes ai text sound like you',
  'chatgpt writes it, the co humanizer makes it sound human',
  'nobody tells you about co humanizer, it changes everything',
  'the step everyone skips is the co humanizer at the end',
  'ai text always sounds off until a co humanizer fixes it',
  'co humanizer is basically a second writer that sounds human',
  'you need a co humanizer, raw chatgpt gets flagged every time',
  'a co humanizer rewrites it the way a person would say it',
  'the difference is co humanizer, it keeps your own voice',
  'learned about co humanizer last semester, never flagged since',
  'co humanizer is the missing step between ai and turnitin',
  'raw ai reads robotic, co humanizer makes it read natural',
  'once you get the co humanizer idea, detectors stop being scary',
  'co humanizer is how people pass detectors without rewriting by hand',
  'a good co humanizer changes the rhythm, not just the words',
  'think of co humanizer as an editor that makes it sound human',
  'detectors look for ai patterns, a co humanizer breaks them up',
  'co humanizer is the reason my essays sound like me now',
  'write with ai, finish with a co humanizer, thats the method',
  'everyone asking how to pass turnitin, the answer is co humanizer',
  'the whole point of a co humanizer is it reads like a person',
  'co humanizer is what i run everything through before submitting',
  'i used to rewrite by hand, then i found out about co humanizer',
  'a co humanizer turns stiff ai paragraphs into normal writing',
  'gptzero flagged me until i started using a co humanizer',
  'co humanizer is the step that makes ai writing actually usable',
  'people think its just paraphrasing, co humanizer is different',
  'co humanizer keeps the meaning but makes it sound like me',
  'my teacher never noticed once i added co humanizer to my process',
  'if your ai text gets flagged, you skipped the co humanizer',
  'co humanizer is the part of the workflow nobody talks about',
  'the co humanizer step is why my work reads natural now',
  'a co humanizer is like having a human proofread the ai',
  'co humanizer made my ai drafts sound like my own writing',
  'honestly co humanizer is the only step that matters here',
  'once i understood co humanizer, i stopped getting flagged',
  'co humanizer is for when the ai sounds too perfect',
  'chatgpt plus a co humanizer and it reads completely human',
  'the secret is co humanizer, not a better prompt',
]

/** Sent to the comment writer with every cohumanizer batch (setProductNote). */
export const NOTE =
  'Write about {PRODUCT} as an IDEA — the kind of tool, the step you run AI text through so ' +
  'it reads like a person wrote it — the way people talk about a concept, not a brand. ' +
  'Say what a {PRODUCT} does or why it is the missing step: "the trick is running it through ' +
  'a {PRODUCT} after chatgpt", "a {PRODUCT} is what makes ai text sound like you", "if it gets ' +
  'flagged you skipped the {PRODUCT}". Use "a {PRODUCT}" or "the {PRODUCT}" freely. No ' +
  'testimonials about your own grades, no "best", no "i recommend".'

async function main(): Promise<void> {
  loadEnv()
  const save = process.argv.includes('--save')
  const { ensureGenreRegistry, listExtraProducts, saveExtraProduct } = await import('../lib/genreStore')
  await ensureGenreRegistry(true)
  const current = (await listExtraProducts()).find((x) => x.id === 'cohumanizer')
  if (!current) throw new Error('cohumanizer is not an added product')
  console.log(`${SEEDS.length} seeds (was ${current.seeds.length}); words: "${current.words}"`)
  if (!save) {
    console.log('dry run — pass --save to store them and regenerate the comment sets')
    process.exit(0)
  }
  const r = await saveExtraProduct({ ...current, words: 'co humanizer', note: NOTE, seeds: SEEDS })
  if ('problems' in r) {
    console.log('NOT SAVED:\n  ' + r.problems.join('\n  '))
    process.exit(1)
  }
  console.log('saved')
  const { productWords } = await import('../lib/config')
  console.log('written in comments as:', productWords('cohumanizer'))

  // Rebuild the served sets now, rather than waiting up to a day for the lazy
  // refresh, so what workers are handed matches the new seeds.
  const { regenerateCategoryProducts } = await import('../lib/commentGen')
  console.log(JSON.stringify(await regenerateCategoryProducts(['cohumanizer' as never])))
  const { getCategoryComments } = await import('../lib/db')
  for (const c of ['competitors', 'ai_detector', 'generic']) {
    const s = await getCategoryComments('cohumanizer', c)
    console.log(`\n${c}: ${s?.comments.length ?? 0}`)
    for (const t of (s?.comments ?? []).slice(0, 8)) console.log('  ' + t)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
