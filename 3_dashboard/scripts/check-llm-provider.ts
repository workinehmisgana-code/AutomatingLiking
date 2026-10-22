// Which model every generation path actually calls, and whether it answers.
//
//   node scripts/run-ts-check.mjs scripts/check-llm-provider.ts
//   node scripts/run-ts-check.mjs scripts/check-llm-provider.ts --live
//
// There is ONE client, lib/llm.ts, and the admin's model setting governs it.
// That is only true while every path goes through it: promoGen.ts used to open
// its own connection to Groq with the model name compiled in, so the setting
// governed six paths and silently not the seventh. Switching the app to Gemini
// would have left promo captions on Groq, and nothing would have said so.
//
// So the first half of this is a grep with a reason: no file outside lib/llm.ts
// may talk to a model API directly.
//
// --live sends one real request per configured provider. Off by default: it
// costs tokens and needs keys, and the wiring is what breaks.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')
const APP = join(ROOT)

function loadEnv(): void {
  const text = readFileSync(join(ROOT, '.env'), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

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
  loadEnv()
  const cfg = await import('../lib/config')
  const llm = await import('../lib/llm')

  console.log('the models on offer:')
  for (const m of cfg.LLM_MODELS) {
    const provider = cfg.llmProvider(m)
    const keyed = !!process.env[llm.LLM_KEY_ENV[provider]]
    console.log(
      `  ${m.padEnd(22)} ${provider.padEnd(7)} ` +
        `${keyed ? 'key set' : 'NO KEY (' + llm.LLM_KEY_ENV[provider] + ')'}`
    )
  }
  console.log(`\n  default when nothing is chosen: ${cfg.DEFAULT_LLM_MODEL}`)

  console.log('\nevery generation path goes through the one client:')
  const files = walk(join(APP, 'lib')).concat(walk(join(APP, 'app')))
  const direct: string[] = []
  for (const f of files) {
    // The client itself, and config where the two base URLs are DEFINED —
    // naming them there is the point, not a second door to the API.
    if (f.endsWith(join('lib', 'llm.ts')) || f.endsWith(join('lib', 'config.ts'))) continue
    const t = readFileSync(f, 'utf8')
    // The two base URLs, and the raw endpoints behind them. A file naming one
    // of these is building its own request rather than asking the client.
    if (
      /GROQ_BASE_URL|GEMINI_BASE_URL|api\.groq\.com|generativelanguage\.googleapis\.com/.test(t)
    ) {
      direct.push(f.slice(APP.length + 1))
    }
  }
  check('  nothing outside lib/llm.ts calls a model API directly', direct, [])
  // And the old module is gone rather than left as a second door.
  const stale = files.filter((f) => f.endsWith(join('lib', 'groq.ts')))
  check('  lib/groq.ts is gone', stale.length, 0)
  const callers = files.filter((f) => /\bllmChat\s*\(/.test(readFileSync(f, 'utf8')))
  console.log(`  ${callers.length} file(s) call llmChat:`)
  for (const f of callers) console.log(`    ${f.slice(APP.length + 1)}`)
  check('  and none of them still names groqChat',
        files.filter((f) => /groqChat/.test(readFileSync(f, 'utf8'))).length, 0)

  console.log('\nthe Gemini request is shaped the way Gemini wants it:')
  const src = readFileSync(join(APP, 'lib', 'llm.ts'), 'utf8')
  // Each of these is a way to get an empty answer back if it is missed.
  check('  the system prompt goes in systemInstruction', /systemInstruction/.test(src), true)
  check('  and is NOT sent as a message', /role: 'system'[\s\S]{0,80}contents/.test(src), false)
  check('  assistant turns are renamed to "model"', /'model' : 'user'/.test(src), true)
  check('  JSON is asked for with responseMimeType', /responseMimeType/.test(src), true)
  // THE TRAP THE 3.x MODELS BRING. They think by default, there is no off
  // setting, and the thought tokens come out of maxOutputTokens - so a caller
  // asking for 200 tokens can have the whole budget spent thinking and get an
  // empty answer, which reads here as a model that cannot hold a JSON shape.
  check('  the output budget leaves room for the thinking',
        /maxTokens \+ THINKING_HEADROOM/.test(src), true)
  // And nothing is sent to lower the thinking level: 'minimal' is already the
  // default and the lowest, and an unrecognised field would be a 400 - which
  // is thrown rather than retried, so it would take every generation down.
  // Tested against the CODE, not the prose: the comment above that line in
  // lib/llm.ts names both fields to explain why neither is sent, and matching
  // the whole file made the check fail on its own explanation.
  const code = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  check('  and no thinking field is invented', /thinkingBudget|thinkingLevel/.test(code), false)
  check('  a blocked answer is not read as an empty one', /finishReason/.test(src), true)

  if (!process.argv.includes('--live')) {
    console.log('\n--live was not passed: nothing was sent to a model.')
    console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall good\n')
    process.exitCode = failures ? 1 : 0
    return
  }

  console.log('\nasking each configured model for one line of JSON:')
  for (const m of cfg.LLM_MODELS) {
    const provider = cfg.llmProvider(m)
    if (!process.env[llm.LLM_KEY_ENV[provider]]) {
      console.log(`  ${m.padEnd(22)} skipped - ${llm.LLM_KEY_ENV[provider]} is not set`)
      continue
    }
    const started = Date.now()
    try {
      // only: no fallback, or this reports another model's success as this one's.
      const { content } = await llm.llmChat({
        model: m,
        only: true,
        jsonObject: true,
        // Not 200: see the headroom note in lib/llm.ts. A budget a thinking
        // model can swallow whole would make this test measure the budget.
        maxTokens: 1000,
        messages: [
          { role: 'system', content: 'Reply with strict JSON: {"ok": true}. Nothing else.' },
          { role: 'user', content: 'Are you there?' },
        ],
      })
      let shape = 'unreadable'
      try {
        shape = JSON.stringify(JSON.parse(content))
      } catch {
        shape = `not JSON: ${content.slice(0, 60)}`
      }
      console.log(`  ${m.padEnd(22)} ${Date.now() - started}ms  ${shape}`)
      if (shape.startsWith('not JSON') || shape === 'unreadable') failures++
    } catch (e) {
      failures++
      console.log(`  ${m.padEnd(22)} FAILED  ${String(e).slice(0, 160)}`)
    }
  }

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
