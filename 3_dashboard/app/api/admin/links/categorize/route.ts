import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { loadVideosJson } from '@/lib/videos'
import {
  getLinkTitles,
  getLinkCategories,
  saveLinkCategories,
  countLinkCategories,
  clearLinkCategories,
  getChannelBios,
  harvestChannelBios,
  getBlockedUrls,
} from '@/lib/db'
import { categorizeChunk, CHUNK, type Categorizable } from '@/lib/linkCategory'
import { handleOf } from '@/lib/channelRank'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Sort links into one audience (competitors / ai_detector / generic) from their
// caption and their channel's bio, so the app can serve comments written for
// that audience.
//
// ONLY LINKS THAT HAVE NO CATEGORY YET. There is no offset: each call takes the
// next slice of *uncategorised* links, and categorising them removes them from
// the set, so the following call naturally continues. That is what makes a
// second press cheap — the earlier design walked all ~89k links skipping the
// decided ones, which cost dozens of round trips and made the progress bar look
// like a full re-run.
//
// `reset: true` clears every decision, which is how a re-categorise is done.
//
// Blocked links are excluded — categorising a link nobody will ever be served is
// wasted Groq quota.

/** Stop starting new prompts here, leaving room to write rows and respond. */
const BUDGET_MS = 40_000
/** Prompts in flight. Groq rate-limits, and lib/groq.ts already falls back. */
const CONCURRENCY = 3
/** Chunks queued per request. Enough to fill the workers for one budget. */
const CHUNKS_PER_REQUEST = CONCURRENCY * 4

/** Every servable link, with the text the classifier reads. */
async function allTargets(): Promise<Categorizable[]> {
  const [videos, titles, bios, blockedUrls] = await Promise.all([
    loadVideosJson().catch(() => []),
    getLinkTitles().catch(() => ({}) as Record<string, string>),
    getChannelBios().catch(() => ({}) as Record<string, string>),
    getBlockedUrls().catch(() => [] as string[]),
  ])
  const blocked = new Set(blockedUrls)
  const out: Categorizable[] = []
  for (const v of videos) {
    const url = String(v.url ?? '')
    if (!url.startsWith('http') || blocked.has(url)) continue
    const handle = handleOf(url)
    out.push({ url, title: titles[url] ?? '', bio: (handle && bios[handle]) || '' })
  }
  // Stable order so repeated runs work through the backlog the same way.
  out.sort((a, b) => a.url.localeCompare(b.url))
  return out
}

/** Only those without a decision yet. */
async function pendingTargets(): Promise<{ pending: Categorizable[]; total: number }> {
  const all = await allTargets()
  const decided = await getLinkCategories().catch(() => ({}) as Record<string, string>)
  return { pending: all.filter((t) => !decided[t.url]), total: all.length }
}

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const [{ pending, total }, counts] = await Promise.all([
    pendingTargets(),
    countLinkCategories().catch(() => ({})),
  ])
  return NextResponse.json({
    // `total` is what this run will do — the uncategorised backlog, not the pool.
    total: pending.length,
    poolTotal: total,
    categorised: total - pending.length,
    counts,
  })
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const body = (await req.json().catch(() => ({}))) as { reset?: unknown }

  if (body.reset === true) {
    try {
      const cleared = await clearLinkCategories()
      return NextResponse.json({ ok: true, cleared })
    } catch (e) {
      return NextResponse.json({ error: `Could not reset: ${String(e)}` }, { status: 500 })
    }
  }

  try {
    // Bios live per-link in the verify list and are dropped by a merge, so lift
    // them into channel_bio first. Cheap, and it means a channel scraped today
    // informs links merged months ago.
    await harvestChannelBios().catch(() => 0)

    const { pending, total } = await pendingTargets()
    if (pending.length === 0) {
      return NextResponse.json({
        ok: true, total: 0, poolTotal: total, processed: 0, remaining: 0, done: true,
        counts: await countLinkCategories().catch(() => ({})),
      })
    }

    const chunks: Categorizable[][] = []
    for (let i = 0; i < pending.length && chunks.length < CHUNKS_PER_REQUEST; i += CHUNK) {
      chunks.push(pending.slice(i, i + CHUNK))
    }

    const deadline = Date.now() + BUDGET_MS
    const decided: { url: string; category: string }[] = []
    let next = 0
    const worker = async () => {
      for (;;) {
        // At least one chunk always runs, or a slow previous request could leave
        // this one doing nothing and the client would loop without progress.
        if (decided.length > 0 && Date.now() >= deadline) return
        const i = next++
        if (i >= chunks.length) return
        const chunk = chunks[i]
        const cats = await categorizeChunk(chunk)
        chunk.forEach((it, k) => decided.push({ url: it.url, category: cats[k] }))
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))

    let saved = 0
    try {
      saved = await saveLinkCategories(decided)
    } catch (e) {
      return NextResponse.json({ error: `Could not save categories: ${String(e)}` }, { status: 500 })
    }

    const remaining = pending.length - decided.length
    return NextResponse.json({
      ok: true,
      total: pending.length,
      poolTotal: total,
      processed: decided.length,
      saved,
      remaining,
      done: remaining <= 0,
      counts: await countLinkCategories().catch(() => ({})),
    })
  } catch (e) {
    return NextResponse.json({ error: `Categorise failed: ${String(e)}` }, { status: 500 })
  }
}
