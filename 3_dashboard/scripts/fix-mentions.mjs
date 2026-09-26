// Rewrite the comments already in the bank so the product is not announced.
//
// Every comment stored before this was written under the old rule, which spelled
// the product as one word — "prohumanly" — and sometimes quoted it. That is the
// shape that reads as an advert to a person and as a brand mention to a filter,
// and it is what the whole bank looks like: the count is in
// scripts/check-mention.mjs.
//
// WHAT IT CHANGES, and nothing else: the name itself. "prohumanly" becomes "pro
// humanly", "#PurifyText" becomes "purify text", quotes around the name come
// off. An inflection is kept where it is — "purifytexted" becomes "purify
// texted" — because only the name is replaced, never the grammar around it.
//
// THE STEM IS NEVER TOUCHED, so every comment still resolves to its product:
// the matchers flatten to letters and digits and ask for a substring, and
// "purify texting" still contains purifytext.
//
// A REWRITE CAN ADD A WORD, which can put a comment one word outside the band
// it was generated for. That is reported rather than fixed: the band is a
// generation target, and a stored comment being one word longer than the model
// was asked for is not worth throwing away a comment over.
//
//   node scripts/fix-mentions.mjs          what would change, nothing written
//   node scripts/fix-mentions.mjs --apply  write it
import { readFileSync } from 'node:fs'

const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const l of env.split('\n')) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const apply = process.argv.includes('--apply')

// ONE TABLE, READ FROM THE SOURCE. A copy here would be a second definition of
// how a product is spelled, and the two would eventually disagree.
const config = readFileSync(new URL('../lib/config.ts', import.meta.url), 'utf8')
const words = {}
{
  const t = config.slice(config.indexOf('const PRODUCT_WORDS'))
  for (const m of t.slice(0, t.indexOf('}')).matchAll(/^\s*(\w+): '([^']+)',/gm)) {
    words[m[1]] = m[2]
  }
}
if (!Object.keys(words).length) {
  console.log('Could not read PRODUCT_WORDS out of lib/config.ts — stopping.')
  process.exit(1)
}

/** The comment with the product written as words. Returns null if unchanged. */
function debrand(text, product) {
  const parts = (words[product] ?? product).split(' ')
  const re = new RegExp(
    `[#"'“‘]?${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s._-]*')}["'”’]?`,
    'i'
  )
  let out = String(text ?? '')
  const m = re.exec(out)
  if (!m || m[0] === parts.join(' ')) return null
  out = out.replace(re, parts.join(' '))
  return out === text ? null : out
}

const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length

const { Pool } = await import('pg')
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
})

let changed = 0
let kept = 0
let grew = 0
const shown = []

for (const table of ['generated_comments', 'category_comments']) {
  const key = table === 'generated_comments' ? ['product'] : ['product', 'category']
  const { rows } = await db
    .query(`SELECT ${key.join(', ')}, comments FROM ${table}`)
    .catch(() => ({ rows: [] }))
  for (const r of rows) {
    const arr = Array.isArray(r.comments) ? r.comments : []
    if (!arr.length) continue
    let touched = false
    const next = arr.map((c) => {
      const fixed = debrand(c, r.product)
      if (fixed === null) {
        kept++
        return c
      }
      changed++
      touched = true
      if (wordCount(fixed) > wordCount(c)) grew++
      if (shown.length < 6) shown.push(`  ${c}\n    -> ${fixed}`)
      return fixed
    })
    if (touched && apply) {
      const where = key.map((k, i) => `${k} = $${i + 2}`).join(' AND ')
      await db.query(
        `UPDATE ${table} SET comments = $1 WHERE ${where}`,
        [JSON.stringify(next), ...key.map((k) => r[k])]
      )
    }
  }
}

console.log(shown.join('\n'))
console.log(
  `\n${changed} comment(s) ${apply ? 'rewritten' : 'would be rewritten'}, ` +
    `${kept} already written as words.`
)
if (grew) {
  console.log(`${grew} of them gain a word by splitting the name — see the note at the top.`)
}
if (!apply && changed) console.log('Nothing was written. Add --apply to write it.')
await db.end()
