// Is the product written as part of the sentence, or announced as a brand?
//
// WHY THIS MATTERS ENOUGH TO CHECK. Twenty-one comments were posted from four
// TikTok accounts, every one of them naming a product as a single capitalised or
// quoted word. Read back later from other signed-in accounts, NONE of them was
// visible to anybody but its author, on videos where those same readers were
// served other people's comments quite happily (6_comment_liker/verify_comments.py).
// So the name's shape is not a style preference here.
//
// THE RULE. The name goes in as the ordinary words it is made of, lowercase, no
// quotes, no hash, and it may be inflected to fit the sentence: "i just purify
// text mine before handing it in", "purify texted my essay".
//
// THE CONSTRAINT ON THE RULE. Every product matcher in this project flattens
// text to letters and digits and asks whether the product name is a SUBSTRING,
// so the stem may never move. "purify texting" flattens to purifytexting, which
// still contains purifytext. "purity texting" reads just as well and is
// invisible to every check we have — including the admin's own "does this
// worker's comment exist" read. That invariant is asserted below, because it is
// the one that would fail silently.
//
//   node scripts/check-mention.mjs
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
let fails = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')

const config = read('lib/config.ts')
const prompt = read('lib/commentPrompt.ts')
const gen = read('lib/commentGen.ts')
const ui = read('components/AdminProductComments.tsx')

// ── the table ──────────────────────────────────────────────────────────────
console.log('every product has a spelling as words:')
const words = {}
const table = config.slice(config.indexOf('const PRODUCT_WORDS'))
for (const m of table.slice(0, table.indexOf('}')).matchAll(/^\s*(\w+): '([^']+)',/gm)) {
  words[m[1]] = m[2]
}
const products = [...config.matchAll(/^\s*'([a-z]+)',$/gm)].map((m) => m[1])
const named = [...new Set(products)].filter((p) => /^[a-z]+$/.test(p))
check('  products in the table', Object.keys(words).length >= 7, true)
for (const p of ['purifytext', 'acoustictext', 'prohumanly', 'humlexic', 'kinprose',
                 'tintfolio', 'cohumanly']) {
  check(`  ${p}`, words[p] ?? null, {
    purifytext: 'purify text',
    acoustictext: 'acoustic text',
    prohumanly: 'pro humanly',
    humlexic: 'hum lexic',
    kinprose: 'kin prose',
    tintfolio: 'tint folio',
    cohumanly: 'co humanly',
  }[p])
}

// ── THE INVARIANT: a split or inflected name still resolves to the product ──
console.log('\nand every form still resolves to the product:')
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const forms = {}
const fTable = config.slice(config.indexOf('const PRODUCT_FORMS'))
for (const m of fTable.slice(0, fTable.indexOf('}')).matchAll(/^\s*(\w+): \[([^\]]+)\],/gm)) {
  forms[m[1]] = m[2].split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
}
check('  there are inflected forms', Object.keys(forms).length >= 1, true)
for (const [product, list] of Object.entries(forms)) {
  for (const f of list) {
    // This is the whole safety property: productsIn() in commentScan asks
    // hay.includes(norm(product)).
    check(`  "${f}" -> ${product}`, norm(f).includes(norm(product)), true)
  }
}
// And the form that would break it is named in the source, so nobody adds one.
check('  the form that would break it is written down',
      /purity texting/.test(config) && /invisible to every check/.test(config), true)

// ── never announced ────────────────────────────────────────────────────────
console.log('\nthe name is never announced:')
check('  quoting is not applied', /style\.quoteBrand \? /.test(config), false)
check('  productMention lowercases', /productWords\(product, style\.splitBrand\)\.toLowerCase\(\)/.test(config), true)
check('  and the setting defaults off', /quoteBrand: false/.test(config), true)
check('  the setting is marked dead', /@deprecated/.test(config.slice(config.indexOf('quoteBrand: boolean') - 400, config.indexOf('quoteBrand: boolean'))), true)
check('  the model is told words, not a name', /ORDINARY WORDS inside the sentence/.test(prompt), true)
check('  no capital', /never capitalised/.test(prompt), true)
check('  no quotes', /no quotation marks around it/.test(prompt), true)
check('  no hashtag', /no hashtag/.test(prompt), true)
check('  not as the opening word', /never at the very start of the sentence/.test(prompt), true)
check('  and the forms are offered to it', /whichever fits the grammar/.test(prompt), true)
// The prompt is a request. The sanitiser is the rule.
check('  a hash in front is stripped', /replace\(\/#\$\/, ''\)/.test(gen), true)
check('  and quotes around it', /u201C/.test(gen), true)
check('  an inflection is left alone', /AN INFLECTION SURVIVES/.test(gen), true)
check('  the dead switch is off the page', /\['Quote the brand',/.test(ui), false)
check('  and the preview shows what is sent', /const brand = words/.test(ui), true)

// ── the liker's own safety net ─────────────────────────────────────────────
console.log('\nand the liker fixes whatever it is handed:')
const like = readFileSync(
  new URL('../../6_comment_liker/like.py', import.meta.url), 'utf8')
check('  it has the same table', /"purifytext": "purify text"/.test(like), true)
check('  it rewrites before typing', /def debrand/.test(like), true)
check('  on the comment it is about to post', /written as words, not a brand/.test(like), true)
check('  and says what it changed', /"; "\.join\(changed\)/.test(like), true)
check('  it does not depend on a deploy', /not the mechanism/.test(like), true)

// ── how much is already stored the old way ─────────────────────────────────
// A number, not an impression: every comment in the bank was written under the
// old default, which quoted the name.
const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})
const announced = (text, product) => {
  const parts = (words[product] ?? product).split(' ')
  const re = new RegExp(`(["'“‘#]\\s*)?${parts.join('[\\s._-]*')}(\\s*["'”’])?`, 'i')
  const m = re.exec(text)
  if (!m) return null
  if (m[1] || m[2]) return 'quoted or hashed'
  if (m[0] !== parts.join(' ')) return 'one word or capitalised'
  return null
}
const tally = { ok: 0, bad: 0 }
const examples = []
for (const table of ['generated_comments', 'category_comments']) {
  const rows = (await db.query(`SELECT product, comments FROM ${table}`)
    .catch(() => ({ rows: [] }))).rows
  for (const r of rows) {
    for (const c of Array.isArray(r.comments) ? r.comments : []) {
      const why = announced(String(c), r.product)
      if (why) {
        tally.bad++
        if (examples.length < 4) examples.push(`${why}: ${c}`)
      } else tally.ok++
    }
  }
}
console.log('\ncomments already in the bank:')
console.log(`   ${tally.ok} write the name as words, ${tally.bad} announce it`)
for (const e of examples) console.log(`     ${e}`)
if (tally.bad) {
  console.log('   these were generated under the old rule. To rewrite them in place:')
  console.log('     node scripts/fix-mentions.mjs            (shows what would change)')
  console.log('     node scripts/fix-mentions.mjs --apply')
}
await db.end()

console.log(fails ? `\n${fails} FAILED` : '\nall correct')
process.exit(fails ? 1 : 0)
