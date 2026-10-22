// Generate the comment pools for the products that are not humanizers.
//
//   node scripts/run-ts-check.mjs scripts/gen-new-products.ts --show
//   node scripts/run-ts-check.mjs scripts/gen-new-products.ts --write
//
// cocodly builds websites and pptera builds slide decks. Nothing about a
// humanizer comment transfers: the audience is not a student worried about a
// detector, it is somebody who needs a site up or a deck done. The prompt layer
// already knows this -- lib/genreCopy.ts holds one entry per genre and
// buildAudiencePrompt reads it through copyForProduct -- so what this script
// does is run the generation and SHOW the prompt it ran with, because a comment
// pool written in the wrong voice is the kind of mistake that is only visible
// once a worker has already pasted it under somebody's video.
//
// --show prints the prompt and the seeds and writes nothing. --write generates
// and replaces the stored pool. Default is --show: this costs Groq tokens and
// overwrites what is stored, so it does not run by accident.
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

function loadEnv(): void {
  // Before anything imports lib/db, which opens a pool from DATABASE_URL at
  // module load time.
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const NEW_PRODUCTS = ['cocodly', 'pptera'] as const

async function main(): Promise<void> {
  loadEnv()
  const write = process.argv.includes('--write')

  const cfg = await import('../lib/config')
  const copy = await import('../lib/prompts')
  const prompt = await import('../lib/prompts')
  const seeds = await import('../lib/comments')

  for (const p of NEW_PRODUCTS) {
    const genre = cfg.genreOfProduct(p)
    const audiences = cfg.audiencesForProduct(p)
    const bank = (seeds.COMMENTS as Record<string, string[]>)[p] ?? []
    console.log(`\n${'='.repeat(72)}`)
    console.log(`${p}  -  genre ${genre} (${cfg.GENRE_LABELS[genre] ?? genre})`)
    console.log('='.repeat(72))
    console.log(`\nwhat the model is told this product is:\n  ${copy.withProduct(copy.copyForProduct(p).what, p)}`)
    console.log(`\n${bank.length} seed comment(s); the generator rewrites these. First three:`)
    for (const c of bank.slice(0, 3)) console.log(`  - ${c}`)
    // THE CHECK THAT MATTERS. If a humanizer word reaches these prompts, the
    // genre layer is not being read and the pool will come out in the wrong
    // voice -- which is invisible until a worker has posted one.
    const HUMANIZER_WORDS = /\b(humaniz|ai detector|turnitin|gptzero|detection|undetectable|plagiaris)/i
    const gen0 = await import('../lib/commentGen')
    const { band, style } = await gen0.settingsFor(p as never)
    for (const c of audiences) {
      const text = prompt.buildAudiencePrompt(p as never, c, band, style)
      const bad = text.match(HUMANIZER_WORDS)
      console.log(`\n--- prompt for audience "${c}" (${text.length} chars) ---`)
      console.log(text)
      console.log(
        bad
          ? `\n  !! this prompt still mentions "${bad[0]}" - the genre copy is not being read`
          : '\n  ok - no humanizer vocabulary anywhere in this prompt'
      )
    }
    console.log(`\naudiences generated for this product: ${audiences.join(', ')}`)
    // competitors is written in lib/genreCopy.ts for this genre but is not
    // generated, because audiencesForGenre sends every non-humanizer genre to
    // `generic` alone -- the categoriser only labels humanizer links, so a
    // competitors set would never be reached. One line in config.ts when their
    // links start being categorised.
  }

  if (!write) {
    console.log(`\n${'-'.repeat(72)}`)
    console.log('--show only: nothing was generated and nothing was written.')
    console.log('Re-run with --write to generate and replace the stored pools.')
    return
  }

  const gen = await import('../lib/commentGen')
  const db = await import('../lib/db')

  /**
   * A new product with no settings row must not take the LIBRARY default.
   *
   * COMMENT_WORD_MIN/MAX are 3 and 8 and DEFAULT_COMMENT_STYLE is the question
   * voice with emoji -- a combination no product in the dashboard actually
   * uses, and one that cannot work: a question has to name the product AND ask
   * something, and eight words does not fit both. pptera generated on it and
   * came back with "Did pptera handle?" and "Did pptera save night?", which are
   * not sentences.
   *
   * So a product with no row is given the house style instead: the band and
   * voice the six humanizer products already share. ONLY when there is no row
   * -- a product somebody has configured is left exactly as they set it.
   */
  const HOUSE_BAND = { min: 8, max: 14 }
  const HOUSE_STYLE = {
    emoji: false,
    splitBrand: false,
    quoteBrand: false,
    voice: 'informational',
  }
  // getProductCommentSettings returns whatever fallback it is handed when the
  // row is absent, so "is there a row" is asked with a band that could never be
  // stored and checking whether it came back untouched.
  const SENTINEL = { min: -1, max: -1 }
  for (const p of NEW_PRODUCTS) {
    const got = await db.getProductCommentSettings(p as never, SENTINEL).catch(() => null)
    const hasRow = !!got && !(got.band.min === SENTINEL.min && got.band.max === SENTINEL.max)
    if (hasRow) {
      console.log(
        `  ${p}: already configured (${got!.band.min}-${got!.band.max} words, ` +
          `${got!.style.voice}${got!.style.emoji ? ', emoji' : ''}) - left alone`
      )
      continue
    }
    await db.setProductWordBand(p as never, HOUSE_BAND)
    await db.setProductCommentStyle(p as never, HOUSE_STYLE as never)
    console.log(
      `  ${p}: had no settings of its own - given the house style ` +
        `(${HOUSE_BAND.min}-${HOUSE_BAND.max} words, ${HOUSE_STYLE.voice}, no emoji)`
    )
  }

  console.log(`\n${'-'.repeat(72)}`)
  console.log('generating (one Groq call per product per audience, sequential)...\n')
  const results = await gen.regenerateCategoryProducts(NEW_PRODUCTS as never)
  for (const [key, r] of Object.entries(results)) {
    console.log(`  ${key.padEnd(24)} ${r.ok ? `${r.count} comment(s)` : `FAILED: ${r.error}`}`)
  }

  // Read back what was stored, rather than trusting the count the generator
  // returned: the pool is what gets served.
  console.log('\nstored, read back:')
  for (const p of NEW_PRODUCTS) {
    for (const c of cfg.audiencesForProduct(p)) {
      const got = await db.getCategoryComments(p as never, c).catch(() => null)
      const list = got?.comments ?? []
      console.log(`\n  ${p}/${c}: ${list.length} comment(s)`)
      for (const line of list.slice(0, 8)) console.log(`    - ${line}`)
      if (list.length > 8) console.log(`    ... and ${list.length - 8} more`)
    }
  }
  // Nothing to close: lib/db owns a module-level pool with no exported
  // shutdown, and the process exits below.
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
