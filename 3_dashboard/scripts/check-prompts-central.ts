// Every prompt lives in lib/prompts.ts, and nowhere else.
//
//   node scripts/run-ts-check.mjs scripts/check-prompts-central.ts
//
// The point of one file is that it STAYS one file. The easy way to undo this is
// to add a new generator with its instruction written inline, which works
// perfectly and quietly puts the prompts back in seven places.
//
// So: no file that calls the model may carry its own instruction text. A system
// message must be a reference to something defined in lib/prompts.ts, never a
// literal.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = process.cwd()

let failures = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)}`}`)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

async function main(): Promise<void> {
  const files = walk(join(ROOT, 'lib')).concat(walk(join(ROOT, 'app')))
  const PROMPTS = join(ROOT, 'lib', 'prompts.ts')

  console.log('no instruction text lives outside lib/prompts.ts:')
  const offenders: string[] = []
  for (const f of files) {
    if (f === PROMPTS) continue
    const t = readFileSync(f, 'utf8')
    // A system message whose content is a quoted string or a template literal
    // is a prompt written in place. One naming an identifier is a reference,
    // which is what this is asking for.
    for (const m of Array.from(t.matchAll(/role:\s*'system'[\s\S]{0,40}?content:\s*([`'"])/g))) {
      offenders.push(`${f.slice(ROOT.length + 1)} (${m[1]}…)`)
    }
  }
  check('  every system message is a reference, not a literal', offenders, [])

  // STRICTER, AND FOR THE USER TURN TOO. A reference is not enough on its own:
  // titleClassify.ts once passed the check above with `content: systemFor(genre)`
  // — a reference, to a prompt it wrote itself. So every message sent through
  // llmChat must be built by a name IMPORTED FROM lib/prompts (directly, or via
  // one local `const x = …` holding such a call), and carry no text of its own:
  // a string with a space in it is instruction text, however short.
  const leaks: string[] = []
  for (const f of files) {
    if (f === PROMPTS) continue
    const t = readFileSync(f, 'utf8')
    if (!/llmChat\(\{/.test(t)) continue
    const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/')
    const imported = new Set<string>()
    for (const m of Array.from(t.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:@\/lib\/|\.\/|\.\.\/)prompts['"]/g))) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()
        if (name) imported.add(name.replace(/^type\s+/, ''))
      }
    }
    const usesPrompts = (expr: string) =>
      Array.from(expr.matchAll(/\b([A-Za-z_]\w*)\b/g)).some((m) => imported.has(m[1]))
    const hasText = (expr: string) => /(['"`])(?:(?!\1)[^\\]|\\.)*\s(?:(?!\1)[^\\]|\\.)*\1/.test(expr)
    for (const m of Array.from(
      t.matchAll(/role:\s*['"](system|user|assistant)['"],?\s*content:\s*([^}]*?)\s*,?\s*\}/g)
    )) {
      let expr = m[2].trim()
      // One hop through a local: `const user = rewriteUser(items)`.
      const local = /^[A-Za-z_]\w*$/.test(expr) && !imported.has(expr)
        ? new RegExp(`(?:const|let)\\s+${expr}\\s*=\\s*([^\\n]+)`).exec(t)
        : null
      if (local) expr = local[1].trim()
      if (!usesPrompts(expr) || hasText(expr)) leaks.push(`${rel} [${m[1]}] ${expr.slice(0, 60)}`)
    }
  }
  check('  every message, system and user, is built in lib/prompts.ts', leaks, [])

  // The counterpart: prompts.ts must not pull in anything a browser cannot
  // load, or the admin prompt editor - which renders the real prompt in the
  // page - stops working.
  const src = readFileSync(PROMPTS, 'utf8')
  console.log('\nand lib/prompts.ts stays loadable in a browser:')
  for (const banned of ['./db', './llm', './videos', 'pg', '@vercel/blob']) {
    check(`  does not import ${banned}`, new RegExp(`from '${banned}'`).test(
      src.split('\n').filter((l) => !l.includes('import type')).join('\n')
    ), false)
  }

  console.log('\nwhat the one file holds:')
  const sections = Array.from(src.matchAll(/^\/\/ ([A-Z][^\n]{8,})$/gm)).map((m) => m[1])
  for (const s of sections) console.log(`  ${s}`)
  const exported = Array.from(src.matchAll(/^export (?:const|function) (\w+)/gm)).map((m) => m[1])
  console.log(`\n  ${exported.length} exported name(s): ${exported.join(', ')}`)
  check('  it exports the genre table', exported.includes('GENRE_COPY'), true)
  check('  the comment prompt builder', exported.includes('buildAudiencePrompt'), true)
  check('  the reply prompts', exported.includes('REPLY_RECOMMEND'), true)
  check('  the categoriser', exported.includes('CATEGORISE_SYSTEM'), true)
  check('  the promo brief', exported.includes('promoSystem'), true)
  check('  the presence analysis', exported.includes('PRESENCE_SYSTEM'), true)

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
