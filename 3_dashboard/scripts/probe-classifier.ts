// Does the harvest's title classifier work with THIS .env's keys (no overrides)?
//   node scripts/run-ts-check.mjs scripts/probe-classifier.ts
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  const { classifyChunk } = await import('../lib/titleClassify')
  const keys = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'LLM_PROVIDER', 'LLM_MODEL']
  console.log('keys present:', keys.filter((k) => process.env[k]).join(', '))
  const items = [
    { url: 'u1', title: 'best AI humanizer to bypass turnitin 2026' },
    { url: 'u2', title: 'how I passed GPTZero with my chatgpt essay' },
    { url: 'u3', title: 'my morning makeup routine' },
  ]
  try {
    const r = await classifyChunk(items, 'humanizer' as never)
    console.log('related:', r)
  } catch (e) {
    console.log('FAILED:', String(e).slice(0, 400))
  }
  // Without the keyword net: the model alone (no humanizer keyword in these).
  try {
    const r = await classifyChunk(
      [{ url: 'm1', title: 'this tool rewrote my essay so the checker says 0% AI' }],
      'humanizer' as never
    )
    console.log('model-only title judged related:', r.length === 1)
  } catch (e) {
    console.log('model call FAILED:', String(e).slice(0, 400))
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
