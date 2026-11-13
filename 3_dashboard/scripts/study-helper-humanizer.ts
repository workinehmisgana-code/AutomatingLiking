// The study helpers (qoloclass, aterera, tintfolio) also have a humanizer built
// in — one of the best. Teach the genre's copy that, give each product base
// comments that mention it, and regenerate their comment sets.
//
//   node scripts/run-ts-check.mjs scripts/study-helper-humanizer.ts           (dry run)
//   node scripts/run-ts-check.mjs scripts/study-helper-humanizer.ts --save    (save + regenerate)
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const WHAT =
  '"{PRODUCT}" is a study helper for students: it explains a topic you are stuck on, turns your notes into ' +
  'practice questions and helps you revise for exams. It ALSO has a humanizer built in — one of the best ' +
  'there is: an essay or assignment drafted with AI comes out reading like you wrote it and passes AI ' +
  'detectors like Turnitin and GPTZero. Two things in one place: studying, and the best humanizer.'

const GENERIC =
  'AUDIENCE: general study, school, university or exam content — study tips, exam stress, essays, ' +
  'assignments, student life — with no app being discussed. The viewer is not shopping for a tool, so lead ' +
  'with what happened to you rather than with the thing you used.\n' +
  'YOUR SITUATION: a student who studies with "{PRODUCT}" and also runs their AI-drafted essays through its ' +
  'humanizer.\n' +
  'WHAT TO SAY: mix the two things it does across the set — roughly a third about STUDYING (it explained the ' +
  'chapter you did not get, it quizzed you on your notes, you passed), a third about its HUMANIZER (your ' +
  'chatgpt essay came back 0% on turnitin, nothing gets flagged, it is the best humanizer you have used, it ' +
  'still sounds like you), and a third about BOTH in one go (you revise with it and humanize your essays in ' +
  'the same place). Saying its humanizer is the best one you have tried is fine. A tip, not a pitch.\n' +
  'NEVER name another app or humanizer, and no beats / wins / unbeatable / number-one language.'

const COMPETITORS =
  'AUDIENCE: the video promotes or reviews a RIVAL study app, tutoring service or humanizer, and the viewer ' +
  'is already looking for help.\n' +
  'YOUR SITUATION: a student who tried a few of these and settled on "{PRODUCT}" because it does both — ' +
  'studying AND the best humanizer you have found.\n' +
  'WHAT TO SAY: that it is the one you kept. Earn it with one small concrete reason: it explained the topic ' +
  'your teacher rushed, it made practice questions from your notes, its humanizer got your AI essay past ' +
  'turnitin, you stopped paying for a separate humanizer. Plain words only.\n' +
  'NEVER name the rival, and NEVER use comparison-ad words (beats, wins, unbeatable, outperforms, the ' +
  'competition, number one, hands down, game changer). Write a comment, not a verdict.'

/** Added to each product's base comments; {P} is the product. */
const HUMANIZER_SEEDS = [
  '{P} has a humanizer too, my chatgpt essay came back 0% on turnitin',
  'i study with {P} and run my essays through its humanizer, nothing gets flagged',
  'the humanizer in {P} is the best one i have tried, it still sounds like me',
  'i revise with {P} and humanize my assignments in the same place',
  'my essay got flagged until i put it through the humanizer on {P}',
  'did not know {P} had a humanizer, honestly the best one i have used',
  'stopped paying for a separate humanizer once i found the one in {P}',
  '{P} explained the topic and then its humanizer fixed my ai draft, saved my whole week',
  'best humanizer i have used is the one inside {P}, my essays pass every time',
  'gptzero flagged my essay, ran it through the humanizer on {P} and it came back human',
  'i use {P} for revision and for humanizing, one app for both',
  'the {P} humanizer keeps my own voice, my teacher never noticed a thing',
  'turnitin used to scare me, now my essays go through the humanizer on {P} first',
  'quizzed myself with {P} for the exam and humanized my essay with it the same night',
  'honestly the humanizer on {P} is better than the paid ones i tried',
  'my ai essay sounded robotic until the humanizer on {P} rewrote it',
]

/** The other study helpers' comment style, for a product still on the
 *  untouched defaults (short emoji questions, which never say what it does). */
const STUDY_STYLE = { emoji: false, splitBrand: false, quoteBrand: false, voice: 'recommendation' }
const STUDY_BAND = { min: 6, max: 12 }

async function main(): Promise<void> {
  const save = process.argv.includes('--save')
  const store = await import('../lib/genreStore')
  await store.ensureGenreRegistry(true)
  const g = (await store.listCustomGenres()).find((x) => x.id === 'study-helper')
  if (!g) throw new Error('the study-helper genre is not saved')
  const products = g.products.map((p) => p.id)
  const seeds: Record<string, string[]> = {}
  for (const p of products) {
    const mine = HUMANIZER_SEEDS.map((s) => s.split('{P}').join(p))
    seeds[p] = Array.from(new Set([...(g.seeds[p] ?? []), ...mine]))
    // Re-runs keep the lines already added, without duplicates.
    console.log(`${p}: ${g.seeds[p]?.length ?? 0} → ${seeds[p].length} base comments`)
  }
  if (!save) {
    console.log('dry run — pass --save to store it and regenerate the comment sets')
    process.exit(0)
  }
  const kw = new Set([...(g.copy.related?.keywords ?? []), 'humanizer', 'aidetector', 'turnitin', 'gptzero', 'essay', 'essays'])
  const next = {
    ...g,
    seeds,
    copy: {
      ...g.copy,
      what: WHAT,
      angles: { ...g.copy.angles, generic: GENERIC, ai_detector: GENERIC, competitors: COMPETITORS },
      voice:
        g.copy.voice +
        ' Humanizer lines read the same way: "ran my essay through it and turnitin said 0%", "it still sounds like me", "nothing gets flagged now".',
      replyRelevance:
        'ONLY reply when the comment is about STUDYING or AI ESSAYS: an exam or test coming up, not understanding a ' +
        'subject or a teacher, homework, revising, grades, study tips, an essay flagged by Turnitin or another AI ' +
        'detector, making AI writing sound human, or looking for something to help them study.\n',
      replyMention:
        'a study helper that explains topics and quizzes you on your notes, with one of the best humanizers built in ' +
        'for essays',
      promo:
        '"{PRODUCT}" is a study helper for students — it explains topics you\'re stuck on, turns your notes into ' +
        'practice questions and helps you revise — and it has one of the best AI humanizers built in, so AI-drafted ' +
        'essays pass Turnitin and GPTZero. Generate short, catchy social-media video captions/titles about studying ' +
        'smarter, passing exams and essays that never get flagged. Casual, student-to-student tone.',
      related: {
        subject:
          (g.copy.related?.subject ?? '') + ', essays and assignments, AI detectors like Turnitin or GPTZero, or making AI writing sound human',
        keywords: Array.from(kw),
      },
      voiceExamples: {
        ...g.copy.voiceExamples,
        plainFact:
          'it explains the topic you are stuck on, turns your notes into practice questions, and its humanizer makes ai essays pass detectors',
      },
    },
  }
  const r = await store.saveCustomGenre(next as never, false)
  if ('problems' in r) {
    console.log('NOT SAVED:\n  ' + r.problems.join('\n  '))
    process.exit(1)
  }
  console.log('saved')

  const db = await import('../lib/db')
  const { regenerateCategory } = await import('../lib/commentGen')
  for (const p of products) {
    // A product still on the default style gets the study helpers' style, so
    // its comments can say what it does at all.
    const { pool } = db as unknown as { pool: import('pg').Pool }
    const row = await pool.query(`SELECT voice FROM product_comment_setting WHERE product = $1`, [p])
    const voice = row.rows[0]?.voice
    if (!voice || voice === 'question') {
      await db.setProductWordBand(p, STUDY_BAND)
      await db.setProductCommentStyle(p, STUDY_STYLE as never)
      console.log(`${p}: style set to the study helpers' (6–12 words, recommendation, no emoji)`)
    }
  }
  // A fresh process reads the settings above (the cache in this one may not):
  // the voice is passed explicitly, so a set's recorded 'question' is not reused.
  for (const p of products) {
    console.log(p, await regenerateCategory(p as never, 'generic' as never, ['recommendation']).catch((e) => String(e)))
  }
  const { getCategoryComments } = db
  for (const p of products) {
    const s = await getCategoryComments(p, 'generic')
    const list = s?.comments ?? []
    const hum = list.filter((t) => /humani[sz]|turnitin|gptzero|flag|detector|0%/i.test(t)).length
    console.log(`\n${p} generic: ${list.length} (${hum} mention the humanizer)`)
    for (const t of list.slice(0, 10)) console.log('  ' + t)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
