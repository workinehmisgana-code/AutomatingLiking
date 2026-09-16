import { GROQ_BASE_URL, LLM_MODELS, DEFAULT_LLM_MODEL, type LlmModel } from './config'
import { getLlmModel } from './db'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * The model the admin chose, cached briefly.
 *
 * Every generation path goes through groqChat, and some of them call it in a
 * loop over a batch — reading the setting from the database on each call would
 * add a round trip per request for a value that changes maybe twice a year. A
 * few seconds of staleness after a switch is invisible; a query per comment is
 * not.
 */
let cached: { model: LlmModel; at: number } | null = null
const CACHE_MS = 30_000

async function chosenModel(): Promise<LlmModel> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.model
  const model = await getLlmModel().catch(() => DEFAULT_LLM_MODEL)
  cached = { model, at: Date.now() }
  return model
}

/** Forget the cached choice — called when the setting is changed. */
export function forgetLlmModelCache(): void {
  cached = null
}

/**
 * Call Groq's chat-completions API with the model the admin chose.
 *
 * On a rate limit (HTTP 429) or a network failure it falls back to the OTHER
 * model on the list rather than giving up: a quota is a property of one model,
 * not of the request. Any other error is thrown immediately — a 400 means the
 * request is wrong and retrying it elsewhere just produces the same 400 twice.
 *
 * Each model family takes the reasoning_effort value it accepts (gpt-oss →
 * "low"; qwen3 → "none" to skip its thinking phase).
 */
export async function groqChat(opts: {
  messages: Msg[]
  temperature?: number
  jsonObject?: boolean
  maxTokens?: number
  timeoutMs?: number
  /** Override the chosen model for one call (used by the admin's test button). */
  model?: LlmModel
}): Promise<{ content: string; model: string }> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY is not set')

  const first = opts.model ?? (await chosenModel())
  // The chosen one, then the others as fallbacks, in order and without repeats.
  const models = [first, ...LLM_MODELS.filter((m) => m !== first)]
  let lastErr = ''

  for (const model of models) {
    const body: Record<string, unknown> = {
      model,
      temperature: opts.temperature ?? 0,
      messages: opts.messages,
    }
    if (opts.jsonObject) body.response_format = { type: 'json_object' }
    body.max_completion_tokens = opts.maxTokens ?? 1200
    // Both are reasoning models but take DIFFERENT reasoning_effort values.
    // gpt-oss accepts "low"; qwen3 only accepts "none"/"default" — and left to
    // think it burns the whole budget and returns empty JSON, so force "none".
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
