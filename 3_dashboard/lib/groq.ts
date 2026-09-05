import { GROQ_BASE_URL, GROQ_MODELS } from './config'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * Call Groq's chat-completions API, trying each model in GROQ_MODELS in order.
 * On a rate-limit / quota error (HTTP 429) it falls back to the next model; any
 * other error is thrown immediately. Returns the assistant message content, and
 * the model that produced it. Each model family gets the reasoning_effort value
 * it accepts (gpt-oss → "low"; qwen3 → "none" to skip its thinking phase).
 */
export async function groqChat(opts: {
  messages: Msg[]
  temperature?: number
  jsonObject?: boolean
  maxTokens?: number
  timeoutMs?: number
}): Promise<{ content: string; model: string }> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY is not set')

  const models = GROQ_MODELS.length ? GROQ_MODELS : ['openai/gpt-oss-120b']
  let lastErr = ''

  for (const model of models) {
    const body: Record<string, unknown> = {
      model,
      temperature: opts.temperature ?? 0,
      messages: opts.messages,
    }
    if (opts.jsonObject) body.response_format = { type: 'json_object' }
    const cap = opts.maxTokens ?? 1200
    body.max_completion_tokens = cap
    // Both current models are reasoning models but take DIFFERENT reasoning_effort
    // values. gpt-oss accepts "low"; qwen3 only accepts "none"/"default" — and left
    // to think it burns the whole budget and returns empty JSON, so force "none".
    if (model.includes('gpt-oss')) body.reasoning_effort = 'low'
    else if (model.includes('qwen')) body.reasoning_effort = 'none'

    let res: Response
    try {
      res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
      })
    } catch (e) {
      lastErr = `Groq request failed on ${model}: ${String(e)}`
      continue // network/timeout → try the next model too
    }

    if (res.status === 429) {
      lastErr = `Groq 429 (rate limit / quota) on ${model}`
      continue // quota exceeded → fall back to the next model
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Groq ${res.status} on ${model}: ${detail.slice(0, 200)}`)
    }
    const data = await res.json()
    return { content: data?.choices?.[0]?.message?.content ?? '', model }
  }
  throw new Error(lastErr || 'All Groq models are rate-limited')
}
