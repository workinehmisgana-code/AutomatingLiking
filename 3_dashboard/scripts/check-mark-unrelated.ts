// "Mark unrelated" asks a different question per genre.
//
//   node scripts/run-ts-check.mjs scripts/check-mark-unrelated.ts
//
// THE BUG THIS EXISTS FOR. The marker asked one question - "is this title about
// AI humanizers?" - and the Links-to-verify page offered it as "Mark humanizer
// unrelated". That was right while every staged link was a humanizer link. Once
// website channels were staged, pressing it marked ALL of their links unrelated
// and offered to block them, because a video about building a website is
// genuinely not about humanizers. The button was correct and useless.
//
// No network: what is being checked is that the question CHANGES with the
// genre, and that nothing judges a link against another genre's definition.
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()

let failures = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`)
}

async function main(): Promise<void> {
  const { GENRES, GENRE_LABELS, DEFAULT_GENRE } = await import('../lib/config')
  const { GENRE_COPY } = await import('../lib/prompts')

  console.log('every genre defines what "related" means for it:')
  for (const g of GENRES) {
    const r = GENRE_COPY[g].related
    check(`  ${g} has a subject`, r.subject.length > 40, true)
    check(`  ${g} has keywords`, r.keywords.length > 0, true)
    // Lowercase alphanumerics only: the matcher strips everything else from the
    // title before comparing, so a keyword with a space or capital can never
    // match and is a safety net with a hole in it.
    const bad = r.keywords.filter((k) => k !== k.toLowerCase() || /[^a-z0-9#]/.test(k))
    check(`  ${g} keywords are match-ready`, bad, [])
  }

  console.log('\nthe genres ask DIFFERENT questions:')
  const subjects = GENRES.map((g) => GENRE_COPY[g].related.subject)
  check('  no two subjects are the same', new Set(subjects).size, GENRES.length)
  // The specific confusion: a humanizer word must not define the website
  // question, or the website marker bins website videos all over again.
  const web = GENRE_COPY.website.related
  check('  the website question is not about humanizers',
        /humaniz|turnitin|detector|gptzero/i.test(web.subject), false)
  check('  and names website things', /website builder/i.test(web.subject), true)
  const slides = GENRE_COPY.slides.related
  check('  the slides question is not about humanizers',
        /humaniz|turnitin|detector|gptzero/i.test(slides.subject), false)
  check('  and names slide things', /slide deck|presentation/i.test(slides.subject), true)
  // No overlap in the keyword nets either: a keyword in two genres would mark a
  // link related under both, which makes the net meaningless where it matters.
  const overlap = web.keywords.filter((k) => GENRE_COPY.humanizer.related.keywords.includes(k))
  check('  the keyword nets do not overlap', overlap, [])

  console.log('\nthe humanizer question is exactly what it was:')
  // Moved, not rewritten - the humanizer marker has to behave identically.
  const h = GENRE_COPY.humanizer.related
  for (const must of ['humanizer', 'turnitin', 'gptzero', 'originalityai', 'undetectableai']) {
    check(`  still catches "${must}"`, h.keywords.includes(must), true)
  }
  check('  and still 17 keywords', h.keywords.length, 17)

  console.log('\nnothing judges a link against another genre’s definition:')
  const classify = readFileSync(join(ROOT, 'lib', 'titleClassify.ts'), 'utf8')
  check('  the system prompt is built per genre', /function systemFor\(genre: Genre\)/.test(classify), true)
  check('  the keyword net is too', /keywordRelated\(title: string, genre: Genre\)/.test(classify), true)
  check('  and a mixed list is split by genre',
        /classifyRelatedByGenre/.test(classify), true)
  // The two callers both have to use the split version, or one of them quietly
  // keeps asking one question of everything.
  for (const f of ['lib/channelHarvest.ts', 'app/api/admin/links/classify/route.ts']) {
    const t = readFileSync(join(ROOT, f), 'utf8')
    check(`  ${f} uses it`, /classifyRelatedByGenre\(/.test(t), true)
    check(`  ${f} does not call the single-genre one`, /\bclassifyRelated\(/.test(t), false)
  }
  // And the harvest must STAMP a genre, or everything it stages reads as the
  // default and the split has nothing to split on.
  const harvest = readFileSync(join(ROOT, 'lib', 'channelHarvest.ts'), 'utf8')
  check('  the harvest stamps the channel’s genre on what it stages',
        /genre: genreOfChannel\.get/.test(harvest), true)

  console.log('\nthe button says which genre it is marking:')
  const ui = readFileSync(join(ROOT, 'components', 'VerifyLinks.tsx'), 'utf8')
  check('  the label is built from the page’s genres', /const pageGenres = useMemo/.test(ui), true)
  check('  and names it', /Mark \$\{GENRE_LABELS\[pageGenres\[0\]\]/.test(ui), true)
  // THE REGRESSION. A hardcoded "humanizer" in the label is the whole bug.
  check('  no hardcoded humanizer in the button', /Mark humanizer unrelated/.test(ui), false)
  check('  the rows send their genre to the classifier', /genre: r\.genre/.test(ui), true)

  console.log(`\nfor reference, what each marker will say:`)
  for (const g of GENRES) console.log(`  ${g.padEnd(10)} → "Mark ${GENRE_LABELS[g] ?? g} unrelated"`)
  console.log(`  (a page holding more than one says just "Mark unrelated", default ${DEFAULT_GENRE})`)

  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n')
  process.exitCode = failures ? 1 : 0
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
