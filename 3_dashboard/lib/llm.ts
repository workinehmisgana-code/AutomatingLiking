// The one place a model is called, whoever serves it.
//
// This was lib/groq.ts and spoke only to Groq. Gemini is served by a different
// API with a different request shape, a different way of carrying the system
// prompt and a different place to put the answer — so the provider lives here
// and every caller keeps asking the same question: messages in, text out.
//
// EVERY generation path goes through this function. Comments, replies, the
// humanizer-related marker, the audience categoriser, the mimic and the
// presence analysis all call it, which is why the admin's model setting is one
// setting rather than six — and why the picker says so.

import {
  GEMINI_BASE_URL,
  GROQ_BASE_URL,
  LLM_MODELS,
  DEFAULT_LLM_MODEL,
  llmProvider,
  type LlmModel,
  type LlmProvider,
} from './config'
import { getLlmModel } from './db'

type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

/**
 * The model the admin chose, cached briefly.
 *
 * Some callers call this in a loop over a batch — reading the setting from the
 * database on each call would add a round trip per request for a value that
 * changes maybe twice a year. A few seconds of staleness after a switch is
 * invisible; a query per comment is not.
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

/** The environment variable each provider's key lives in. */
export const LLM_KEY_ENV: Record<LlmProvider, string> = {
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

function apiKeyFor(provider: LlmProvider): string {
  return process.env[LLM_KEY_ENV[provider]] ?? ''
}

/**
 * A failure worth trying the NEXT model for, rather than giving up.
 *
 * A quota is a property of one model and a timeout of one request; a 400 is a
 * property of the request itself and would produce the same 400 twice. Thrown
 * rather than returned so the two cases cannot be confused at the call site.
 */
class TryNext extends Error {}

/**
 * Room for the thinking a 3.x model does before it answers.
 *
 * Added to whatever the caller asked for rather than replacing it: the caller's
 * number is about the ANSWER, and it is still the number the prompt tells the
 * model to write to.
 */
const THINKING_HEADROOM = 2048
/** The 3.x Flash-Lite ceiling; asking for more is a 400. */
const GEMINI_MAX_OUTPUT = 65_536

type Call = {
  model: LlmModel
  messages: Msg[]
  temperature: number
  maxTokens: number
  jsonObject: boolean
  timeoutMs: number
  apiKey: string
}

// ── Groq ────────────────────────────────────────────────────────────────────
async function callGroq(c: Call): Promise<string> {
  const body: Record<string, unknown> = {
    model: c.model,
    temperature: c.temperature,
    messages: c.messages,
    max_completion_tokens: c.maxTokens,
  }
  if (c.jsonObject) body.response_format = { type: 'json_object' }
  // Both are reasoning models but take DIFFERENT reasoning_effort values.
  // gpt-oss accepts "low"; qwen3 only accepts "none"/"default" — and left to
  // think it burns the whole budget and returns empty JSON, so force "none".
  if (c.model.includes('gpt-oss')) body.reasoning_effort = 'low'
  else if (c.model.includes('qwen')) body.reasoning_effort = 'none'

  let res: Response
  try {
    res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(c.timeoutMs),
    })
  } catch (e) {
    throw new TryNext(`Groq request failed on ${c.model}: ${String(e)}`)
  }
  if (res.status === 429) throw new TryNext(`Groq 429 (rate limit / quota) on ${c.model}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Groq ${res.status} on ${c.model}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

// ── Gemini ──────────────────────────────────────────────────────────────────
//
// Three things differ from an OpenAI-shaped API and each one is a way to get an
// empty string back if it is missed:
//
//   the system prompt is NOT a message. It goes in systemInstruction; sent as a
//   message with role "system" it is rejected outright.
//   the roles are user/model, not user/assistant.
//   JSON is asked for with responseMimeType, not response_format.
async function callGemini(c: Call): Promise<string> {
  const system = c.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const contents = c.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }))

  const generationConfig: Record<string, unknown> = {
    temperature: c.temperature,
  }
  if (c.jsonObject) generationConfig.responseMimeType = 'application/json'
  // THINKING CANNOT BE TURNED OFF ON 3.x, SO IT IS GIVEN ROOM INSTEAD.
  //
  // Gemini 2.5 Flash-Lite had thinking off by default and took
  // thinkingConfig.thinkingBudget = 0. The 3.x Flash-Lite models think by
  // default at the lowest level there is ('minimal') and have no off setting
  // at all, and the thought tokens come OUT OF maxOutputTokens.
  //
  // So a caller asking for 200 tokens can have the whole budget spent thinking
  // and get an empty answer back - which every caller here would read as a
  // model that cannot hold a JSON shape. Google's own guidance is to lower the
  // thinking level rather than squeeze max_output_tokens, 'which can truncate
  // output while still billing for thinking tokens'.
  //
  // Nothing is sent to lower it, because 'minimal' is already the default and
  // the lowest; an unrecognised field would be a 400, which is not retried.
  // The headroom is what makes the answer survive the thinking.
  generationConfig.maxOutputTokens = Math.min(c.maxTokens + THINKING_HEADROOM, GEMINI_MAX_OUTPUT)

  const body = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig,
  }

  let res: Response
  try {
    res = await fetch(
      `${GEMINI_BASE_URL}/models/${encodeURIComponent(c.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': c.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(c.timeoutMs),
      }
    )
  } catch (e) {
    throw new TryNext(`Gemini request failed on ${c.model}: ${String(e)}`)
  }
  // 429 is the quota; 503 is the model being briefly overloaded, which is the
  // same kind of "try something else" as a quota rather than a bad request.
  if (res.status === 429 || res.status === 503) {
    throw new TryNext(`Gemini ${res.status} on ${c.model}`)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Gemini ${res.status} on ${c.model}: ${detail.slice(0, 200)}`)
  }

  const data = await res.json()
  const cand = data?.candidates?.[0]
  // A BLOCKED ANSWER IS NOT AN EMPTY ONE. Gemini returns 200 with no parts and
  // a finishReason when its filters stop a generation; returning '' here would
  // reach the caller as unparseable JSON and be reported as a model that cannot
  // hold a shape. Falling through to the next model is the honest response, and
  // the reason is carried so the log says what happened.
  const reason = String(cand?.finishReason ?? '')
  const text: string = (cand?.content?.parts ?? [])
    .map((p: { text?: unknown }) => String(p?.text ?? ''))
    .join('')
  if (!text) {
    const why = reason || String(data?.promptFeedback?.blockReason ?? '') || 'no reason given'
    throw new TryNext(`Gemini returned nothing on ${c.model} (${why})`)
  }
  return text
}

/**
 * Ask the chosen model, falling back to the others.
 *
 * On a rate limit, an overload or a network failure it moves to the NEXT model
 * on the list rather than giving up. Any other error is thrown immediately — a
 * 400 means the request is wrong and retrying it elsewhere produces the same
 * 400 twice.
 *
 * A model whose provider has no API key configured is skipped with that said
 * plainly, rather than attempted and failed: with two providers on one list,
 * "all models are rate-limited" would be a misleading way to report a missing
 * key.
 */
export async function llmChat(opts: {
  messages: Msg[]
  temperature?: number
  jsonObject?: boolean
  maxTokens?: number
  timeoutMs?: number
  /** Override the chosen model for one call (used by the admin's test button). */
  model?: LlmModel
  /**
   * Try ONLY that model, with no fallback.
   *
   * For the admin's test button, where falling back defeats the purpose: asking
   * "does Gemini work" and getting a cheerful yes from Groq is worse than an
   * error, because it is the answer you were checking for.
   */
  only?: boolean
}): Promise<{ content: string; model: string }> {
  const first = opts.model ?? (await chosenModel())
  // The chosen one, then the others as fallbacks, in order and without repeats.
  const models = opts.only ? [first] : [first, ...LLM_MODELS.filter((m) => m !== first)]
  const missing: string[] = []
  let lastErr = ''

  for (const model of models) {
    const provider = llmProvider(model)
    const apiKey = apiKeyFor(provider)
    if (!apiKey) {
      const note = `${model} needs ${LLM_KEY_ENV[provider]}`
      if (!missing.includes(note)) missing.push(note)
      continue
    }
    const call: Call = {
      model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0,
      maxTokens: opts.maxTokens ?? 1200,
      jsonObject: opts.jsonObject ?? false,
      timeoutMs: opts.timeoutMs ?? 45_000,
      apiKey,
    }
    try {
      const content = provider === 'gemini' ? await callGemini(call) : await callGroq(call)
      return { content, model }
    } catch (e) {
      if (e instanceof TryNext) {
        lastErr = e.message
        continue
      }
      throw e
    }
  }

  if (!lastErr && missing.length) {
    throw new Error(`No model can be called: ${missing.join('; ')}`)
  }
  throw new Error(
    lastErr
      ? missing.length
        ? `${lastErr} (and ${missing.join('; ')})`
        : lastErr
      : 'No model could be reached'
  )
}
