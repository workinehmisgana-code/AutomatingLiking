import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { llmChat } from '@/lib/llm'
import { GENRE_DRAFT_SYSTEM } from '@/lib/prompts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { label, products: [{id, site}], description } — draft everything else a
// genre needs, for the admin to read and edit before saving. Saves nothing.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!isAdminEmail(session?.user?.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const b = (await req.json().catch(() => ({}))) as {
    label?: string
    products?: { id?: string; site?: string }[]
    description?: string
  }
  const label = String(b.label ?? '').trim()
  const products = (b.products ?? []).filter((p) => p?.id)
  const description = String(b.description ?? '').trim()
  if (!label || products.length === 0 || !description) {
    return NextResponse.json(
      { error: 'Give the genre a name, at least one product, and say what the product does.' },
      { status: 400 }
    )
  }
  const user =
    `CATEGORY: ${label}\n` +
    `PRODUCT(S): ${products.map((p) => `${p.id}${p.site ? ` (${p.site})` : ''}`).join(', ')}\n` +
    `WHAT THE PRODUCT DOES: ${description}`
  try {
    const { content, model } = await llmChat({
      messages: [
        { role: 'system', content: GENRE_DRAFT_SYSTEM },
        { role: 'user', content: user },
      ],
      jsonObject: true,
      temperature: 0.6,
      maxTokens: 6000,
      timeoutMs: 55_000,
    })
    const text = content.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    const draft = JSON.parse(text) as Record<string, unknown>
    return NextResponse.json({ ok: true, model, draft })
  } catch (e) {
    return NextResponse.json(
      { error: `Could not draft: ${String((e as Error)?.message || e)}` },
      { status: 502 }
    )
  }
}
