// Do the comments sound like a person or like the company?
//
// The writer is supposed to be an ordinary user who does not know the jargon.
// This runs the JARGON filter over every comment already stored, so the size of
// the problem is a number rather than an impression, and checks that the filter
// keeps the register we DO want — "turnitin didn't flag it" is exactly right and
// must survive.
//
//   node scripts/check-naive-voice.mjs
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

/** Mirrors JARGON in lib/commentGen.ts. */
const JARGON = new RegExp(
  [
    String.raw`\bhumaniz(e|es|ed|er|ers|ing|ation)\b`,
    String.raw`\bai[\s-]?(content|text|writing|generated)\b`,
    String.raw`\bbypass(es|ed|ing)?\b`,
    String.raw`\bundetectable\b`,
    String.raw`\balgorithm(s|ic)?\b`,
    String.raw`\bparaphras(e|es|ed|ing|er)\b`,
    String.raw`\b(nlp|api)\b`,
    String.raw`\b(software|platform|solution|technology|engine)\b`,
    String.raw`\b(output|input)s?\b`,
    String.raw`\bgenerat(e|es|ed|ing|ion)\b`,
    String.raw`\b(accuracy|efficiency|seamless(ly)?|effortless(ly)?|optimi[sz]e[ds]?)\b`,
  ].join('|'),
  'i'
)

console.log('what the filter keeps — the register we want:')
for (const s of [
  "turnitin didn't flag it and my prof said nothing",
  'i paste my essay in and it comes back clean every time',
  'it still sounds like me which is the part i care about',
  'honestly i stopped stressing about my assignments after i found it',
  'my whole class uses it now lol',
  'does anyone else run everything through it before handing it in?',
  // These three starved the generator when the filter was wider. A student
  // saying "the detector" or "it came back 0%" is the register we WANT, and the
  // ai_detector audience has almost nothing else to talk about — banning them
  // left the model nothing to say and every batch came back empty.
  'the detector flagged my last one but not this',
  'it came back 0% which i did not expect',
  'this tool is the only one i kept using',
]) {
  check(`  "${s.slice(0, 46)}…"`, JARGON.test(s), false)
}

console.log('\nwhat it rejects — the company talking:')
for (const s of [
  'this humanizer bypasses every ai detector out there',
  'the output reads fully human every time',
  'best for undetectable ai content',
  'the algorithm paraphrases your text seamlessly',
  'great software with unmatched accuracy',
]) {
  check(`  "${s.slice(0, 46)}…"`, JARGON.test(s), true)
}

// ── how much of what is already stored would be rejected ────────────────────
const { Pool } = await import('pg')
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
// One row per product, its set held as a JSON array.
const sets = (await db.query(
  'SELECT product, comments FROM generated_comments ORDER BY product'
).catch(() => ({ rows: [] }))).rows
const rows = []
for (const r of sets) {
  const arr = Array.isArray(r.comments) ? r.comments : []
  for (const c of arr) rows.push({ product: r.product, text: String(c ?? '') })
}
if (rows.length === 0) {
  console.log('\n(no stored comments to measure)')
} else {
  const per = new Map()
  for (const r of rows) {
    const e = per.get(r.product) ?? { n: 0, bad: 0, samples: [] }
    e.n++
    if (JARGON.test(r.text)) {
      e.bad++
      if (e.samples.length < 2) e.samples.push(r.text)
    }
    per.set(r.product, e)
  }
  console.log(`\nthe ${rows.length.toLocaleString()} comments already stored:`)
  for (const [product, e] of Array.from(per.entries()).sort((a, b) => b[1].bad - a[1].bad)) {
    console.log(
      `   ${product.padEnd(14)} ${String(e.bad).padStart(5)} of ${String(e.n).padStart(5)} ` +
        `(${Math.round((e.bad / e.n) * 100)}%) read as the company talking`
    )
    for (const s of e.samples) console.log(`        "${s.slice(0, 76)}"`)
  }
  const bad = rows.filter((r) => JARGON.test(r.text)).length
  console.log(`   ${bad.toLocaleString()} of ${rows.length.toLocaleString()} overall`)
  console.log('   (these are already stored — regenerate a product to replace its set)')
}

// A prompt saved on the comments page REPLACES the built-in one, so an edit to
// buildSystemPrompt does nothing for that product. Worth knowing before anyone
// wonders why the new instruction had no effect.
const saved = (await db.query(
  "SELECT product FROM product_comment_setting WHERE coalesce(prompt, '') <> ''"
).catch(() => ({ rows: [] }))).rows
console.log('\nproducts with a hand-edited prompt saved on the comments page:')
if (saved.length === 0) console.log('   none — every product uses the built-in prompt, so the change applies to all')
else {
  for (const r of saved.rows ?? saved) console.log(`   ${r.product} — its saved prompt WINS; edit it there too`)
}
await db.end()

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
