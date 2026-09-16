import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, LLM_MODELS, LLM_MODEL_LABELS, isLlmModel } from '@/lib/config'
import { getLlmModel, setLlmModel } from '@/lib/db'
import { groqChat, forgetLlmModelCache } from '@/lib/groq'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Which model every generation uses.
//
// ONE setting for the whole app: comments, replies, title classification and
// audience analysis all go through groqChat. Stored rather than compiled in, so
// switching does not need a deploy — which is the point of having it, since the
// reason to switch is usually that one model has started refusing or drifting.
//
//   GET                    the current choice and what is on offer
//   POST { model }         choose one
//   POST { test: model }   send that model a one-line request and report back

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    return NextResponse.json({
      ok: true,
      model: await getLlmModel(),
      models: LLM_MODELS.map((id) => ({ id, label: LLM_MODEL_LABELS[id] })),
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { model?: unknown; test?: unknown }

  // ── try one before committing to it ───────────────────────────────────────
  if (body.test !== undefined) {
    const model = String(body.test ?? '')
    if (!isLlmModel(model)) {
      return NextResponse.json({ error: `Unknown model: ${model}` }, { status: 400 })
    }
    const started = Date.now()
    try {
      const { content, model: used } = await groqChat({
        model,
        jsonObject: true,
        maxTokens: 2000,
        messages: [
          { role: 'system', content: 'Reply with strict JSON: {"ok": true}. Nothing else.' },
          { role: 'user', content: 'Are you there?' },
        ],
      })
      let parsed: unknown = null
      try {
        parsed = JSON.parse(content)
      } catch {
        /* reported below as unreadable */
      }
      return NextResponse.json({
        ok: true,
        model: used,
        // A model that answers but cannot hold to a JSON shape is no use here:
        // every caller asks for JSON and throws on anything else.
        json: parsed !== null,
        ms: Date.now() - started,
        // Trimmed: this is a health check, not a transcript.
        reply: String(content).slice(0, 120),
        // Falling back means the one asked for refused.
        fellBack: used !== model,
      })
    } catch (e) {
      return NextResponse.json(
        { error: String((e as Error)?.message ?? e).slice(0, 300), ms: Date.now() - started },
        { status: 502 }
      )
    }
  }

  // ── choose ────────────────────────────────────────────────────────────────
  try {
    const model = await setLlmModel(String(body.model ?? ''))
    // The client caches the choice for half a minute; drop it so the very next
    // generation uses the new model rather than the old one for another 30s.
    forgetLlmModelCache()
    return NextResponse.json({ ok: true, model })
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 400 })
  }
}
