import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getLinksNeedingReplies,
  saveReplyDrafts,
  getReplyDrafts,
  setReplyUsed,
  getReplyWordBand,
  setReplyWordBand,
  saveReplySkips,
  countReplySkips,
  clearReplySkips,
} from '@/lib/db'
import { draftReplies, CHUNK, REPLY_WORD_MIN, REPLY_WORD_MAX } from '@/lib/replyGen'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Generate and browse reply drafts for the top comment of scanned links.
//
// Only links that have been scanned have a top comment stored, so this always
// follows a comment scan rather than standing alone.

/** Leave room to write drafts and respond. */
const BUDGET_MS = 40_000
/** Prompts in flight. Groq rate-limits; lib/groq.ts already falls back. */
const CONCURRENCY = 2

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const sp = req.nextUrl.searchParams
  if (sp.get('pending') === '1') {
    const [list, band, unrelated] = await Promise.all([
      getLinksNeedingReplies(500).catch(() => []),
      getReplyWordBand({ min: REPLY_WORD_MIN, max: REPLY_WORD_MAX }).catch(() => ({
        min: REPLY_WORD_MIN,
        max: REPLY_WORD_MAX,
      })),
      countReplySkips().catch(() => 0),
    ])
    return NextResponse.json({ pending: list.length, band, unrelated })
  }
  const offset = Math.max(0, Number(sp.get('offset')) || 0)
  const limit = Math.min(200, Math.max(1, Number(sp.get('limit')) || 50))
  const q = sp.get('q') ?? ''
  try {
    const page = await getReplyDrafts({ offset, limit, q })
    return NextResponse.json({ ...page, offset, limit })
  } catch (e) {
    return NextResponse.json({ error: `Could not load: ${String(e)}` }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown
    id?: unknown
    used?: unknown
  }

  // Saving the word band is its own action so it can be set BEFORE generating,
  // rather than being a parameter of a run that has already started.
  if (body.action === 'band') {
    const min = Number((body as { min?: unknown }).min)
    const max = Number((body as { max?: unknown }).max)
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return NextResponse.json({ error: 'Give a minimum and a maximum.' }, { status: 400 })
    }
    const band = await setReplyWordBand(min, max)
    return NextResponse.json({ ok: true, band })
  }

  // Forget every "unrelated" verdict, so those comments are judged again. For
  // after the relevance rule changes.
  if (body.action === 'clearSkips') {
    const cleared = await clearReplySkips().catch(() => 0)
    return NextResponse.json({ ok: true, cleared })
  }

  if (body.action === 'used') {
    const id = Number(body.id)
    if (!Number.isFinite(id)) return NextResponse.json({ error: 'Bad id' }, { status: 400 })
    await setReplyUsed(id, body.used === true).catch(() => {})
    return NextResponse.json({ ok: true })
  }

  // Default action: generate drafts for links that have a top comment but no
  // reply yet. Ordered by top-comment likes, so the most-read comments on the
  // most-engaged videos get a draft first.
  try {
    const targets = await getLinksNeedingReplies(200)
    if (targets.length === 0) {
      return NextResponse.json({ ok: true, generated: 0, remaining: 0, done: true })
    }
    const chunks: typeof targets[] = []
    for (let i = 0; i < targets.length; i += CHUNK) chunks.push(targets.slice(i, i + CHUNK))

    const band = await getReplyWordBand({ min: REPLY_WORD_MIN, max: REPLY_WORD_MAX }).catch(() => ({
      min: REPLY_WORD_MIN,
      max: REPLY_WORD_MAX,
    }))
    const deadline = Date.now() + BUDGET_MS
    let generated = 0
    let skipped = 0
    let attempted = 0
    let next = 0
    const worker = async () => {
      for (;;) {
        if (attempted > 0 && Date.now() >= deadline) return
        const i = next++
        if (i >= chunks.length) return
        attempted += chunks[i].length
        const { drafts, skips } = await draftReplies(chunks[i], band)
        if (drafts.length > 0) generated += await saveReplyDrafts(drafts).catch(() => 0)
        // Recorded so an unrelated comment is judged once, not on every run.
        if (skips.length > 0) skipped += await saveReplySkips(skips).catch(() => 0)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))

    const left = await getLinksNeedingReplies(500).catch(() => [])
    return NextResponse.json({
      ok: true,
      band,
      generated,
      skipped,
      attempted,
      remaining: left.length,
      done: left.length === 0,
    })
  } catch (e) {
    return NextResponse.json({ error: `Generation failed: ${String(e)}` }, { status: 500 })
  }
}
