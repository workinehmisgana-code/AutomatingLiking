// Can both selectable models do what this app actually asks of them?
//
// Every caller asks for strict JSON and throws on anything else, so "the model
// responds" is not the test — "the model returns parseable JSON of the right
// shape" is. Both are reasoning models and they take DIFFERENT reasoning_effort
// values; qwen left to think burns the whole budget and returns an empty string,
// which is how a working model looks broken.
//
// This also checks the configured list against what the key can actually serve.
//
//   node scripts/check-llm-models.mjs
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

const key = process.env.GROQ_API_KEY
if (!key) {
  console.log('GROQ_API_KEY is not set — cannot check')
  process.exit(0)
}
const BASE = 'https://api.groq.com/openai/v1'

// The list the app offers, read from config so the two cannot drift.
const cfg = readFileSync(new URL('../lib/config.ts', import.meta.url), 'utf8')
const listed = [
  ...(cfg.match(/export const LLM_MODELS = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g),
].map((m) => m[1])
console.log('the app offers:', listed.join(', '))

const avail = (await (await fetch(`${BASE}/models`, {
  headers: { Authorization: `Bearer ${key}` },
})).json()).data.map((m) => m.id)

console.log('\nevery offered model is one this key can serve:')
for (const id of listed) check(`  ${id}`, avail.includes(id), true)

/** One request of the shape every caller makes. */
async function ask(model) {
  const body = {
    model,
    temperature: 0.9,
    messages: [
      {
        role: 'system',
        content:
          'Return strict JSON: {"comments": ["...", ...]} with one rewrite per input, same order. ' +
          'Each rewrite is lowercase, casual, and mentions "purify text".',
      },
      { role: 'user', content: JSON.stringify([{ text: 'it always comes back clean', words: 6 }]) },
    ],
    response_format: { type: 'json_object' },
    max_completion_tokens: 6000,
  }
  if (model.includes('gpt-oss')) body.reasoning_effort = 'low'
  else if (model.includes('qwen')) body.reasoning_effort = 'none'
  const started = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - started
  if (!res.ok) return { ok: false, ms, detail: (await res.text()).slice(0, 120) }
  const d = await res.json()
  const content = d?.choices?.[0]?.message?.content ?? ''
  let parsed = null
  try {
    parsed = JSON.parse(content)
  } catch {
    /* reported as unparseable */
  }
  return {
    ok: true,
    ms,
    empty: content === '',
    json: parsed !== null,
    comments: Array.isArray(parsed?.comments) ? parsed.comments : null,
    usage: d?.usage ?? null,
  }
}

console.log('\neach model, asked for exactly what the app asks for:')
for (const model of listed) {
  const r = await ask(model)
  if (!r.ok) {
    console.log(`   ${model}: HTTP error after ${r.ms}ms — ${r.detail}`)
    fails++
    continue
  }
  console.log(
    `   ${model.padEnd(22)} ${String(r.ms).padStart(5)}ms · ` +
      `${r.empty ? 'EMPTY REPLY' : r.json ? 'valid JSON' : 'not JSON'}` +
      (r.usage ? ` · ${r.usage.completion_tokens} completion tokens` : '')
  )
  if (r.comments) console.log(`      e.g. ${JSON.stringify(r.comments[0])}`)
  check(`  ${model} returns parseable JSON`, r.json, true)
  check(`  ${model} returns a comments array`, Array.isArray(r.comments), true)
}

console.log(`\n${fails === 0 ? 'all correct' : fails + ' FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
