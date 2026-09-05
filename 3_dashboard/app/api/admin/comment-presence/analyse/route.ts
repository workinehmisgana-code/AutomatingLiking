import { NextResponse, type NextRequest } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import {
  getPresenceLinks,
  getPresenceHistoryForUser,
  getUserProfile,
  getUserNameEmail,
  type PresenceLinkRow,
} from '@/lib/db'
import { handleFromProfile } from '@/lib/commentPresence'
import { groqChat } from '@/lib/groq'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Ask the model why this worker's comments are disappearing.
//
// EVERY judged link feeds the answer, but not as raw rows: 200+ items with full
// titles blows past the free tier's per-minute token budget, and a truncated
// dump would not be "the whole context" either. So the whole set is aggregated
// here — by day, by product, by video size, by the words in the titles, by the
// exact comment text, plus the working pace — and the model receives those
// totals alongside an illustrative sample. Every row is represented in the
// numbers; the samples exist to give the numbers something concrete to quote.

/** Raw items shown per bucket, on top of the aggregates over everything. */
const SAMPLE = 30
/** Titles are the richest signal but also the longest field. */
const TITLE_CHARS = 110

interface Bucket {
  found: number
  missing: number
  skipped: number
}

const emptyBucket = (): Bucket => ({ found: 0, missing: 0, skipped: 0 })

function statusOf(r: PresenceLinkRow): keyof Bucket {
  if (!r.judgeable) return 'skipped'
  return r.found ? 'found' : 'missing'
}

/** Even stride, so a sample spans the whole window instead of one afternoon. */
function spread<T>(all: T[], n: number): T[] {
  if (all.length <= n) return all
  const step = all.length / n
  const out: T[] = []
  for (let i = 0; i < n; i++) out.push(all[Math.floor(i * step)])
  return out
}

function tally(
  rows: PresenceLinkRow[],
  key: (r: PresenceLinkRow) => string | null
): Record<string, Bucket> {
  const out: Record<string, Bucket> = {}
  for (const r of rows) {
    const k = key(r)
    if (k === null) continue
    const b = out[k] ?? emptyBucket()
    b[statusOf(r)]++
    out[k] = b
  }
  return out
}

const sizeBand = (views: number | null): string | null =>
  views === null
    ? null
    : views < 1_000
      ? '<1k views'
      : views < 10_000
        ? '1k-10k'
        : views < 100_000
          ? '10k-100k'
          : '100k+'

const STOP = new Set(
  ('the a an and or of to for in on with my your you i it is are was be this that how why what ' +
    'when do does did not no yes if then so at from by as but we they he she me us can will just ' +
    'get got make made use using used its their his her our out up down more most all any some ' +
    'about into over after before new best top tiktok video like').split(' ')
)

/**
 * Words appearing in MISSING titles far more than in found ones.
 *
 * Counted here rather than left to the model: it cannot tally 200 titles
 * reliably, and a term list it invented would be exactly the kind of confident
 * nonsense that gets a worker blocked for nothing.
 */
function titleTerms(rows: PresenceLinkRow[]): { term: string; missing: number; found: number }[] {
  const f: Record<string, number> = {}
  const m: Record<string, number> = {}
  for (const r of rows) {
    if (!r.title || !r.judgeable) continue
    const words = r.title
      .toLowerCase()
      .replace(/[^a-z0-9@. ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
    // Per title, not per occurrence: one video repeating a word ten times must
    // not outweigh ten videos mentioning it once.
    const seen = Array.from(new Set(words))
    for (const w of seen) {
      const target = r.found ? f : m
      target[w] = (target[w] ?? 0) + 1
    }
  }
  const out: { term: string; missing: number; found: number }[] = []
  for (const w of Object.keys(m)) {
    const n = m[w]
    if (n < 3) continue
    const fc = f[w] ?? 0
    if (n >= (fc + 1) * 2) out.push({ term: w, missing: n, found: fc })
  }
  return out.sort((a, b) => b.missing - a.missing).slice(0, 25)
}

/** Working-pace gaps: within a day, under two minutes, breaks excluded. */
function paceStats(rows: PresenceLinkRow[]): {
  gaps: number
  avgSec: number | null
  medSec: number | null
} {
  const byDay: Record<string, number[]> = {}
  for (const r of rows) {
    if (!r.clickedAt) continue
    const t = new Date(r.clickedAt).getTime()
    if (!Number.isFinite(t)) continue
    byDay[r.day] = [...(byDay[r.day] ?? []), t]
  }
  const gaps: number[] = []
  for (const day of Object.keys(byDay)) {
    const times = byDay[day].sort((a, b) => a - b)
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000)
  }
  const w = gaps.filter((g) => g <= 120).sort((a, b) => a - b)
  return {
    gaps: w.length,
    avgSec: w.length ? Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10 : null,
    medSec: w.length ? w[Math.floor(w.length / 2)] : null,
  }
}

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => ({}))) as { userId?: unknown; days?: unknown }
  const userId = String(body.userId ?? '').trim()
  if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  const days = Math.max(1, Math.min(60, Number(body.days) || 7))

  try {
    const [profile, info, rows, history] = await Promise.all([
      getUserProfile(userId).catch(() => null),
      getUserNameEmail(userId).catch(() => null),
      getPresenceLinks(userId, days),
      getPresenceHistoryForUser(userId, days).catch(() => []),
    ])
    if (rows.length === 0) {
      return NextResponse.json({ error: 'No judged links for this user yet.' }, { status: 400 })
    }

    const found = rows.filter((r) => r.judgeable && r.found)
    const missing = rows.filter((r) => r.judgeable && !r.found)
    const skipped = rows.filter((r) => !r.judgeable)
    const withAssigned = rows.filter((r) => r.assigned).length

    // ── aggregates, over EVERY row ────────────────────────────────────────
    const assignedTally = tally(rows, (r) => r.assigned)
    const context = {
      worker: profile?.name || info?.name || userId,
      handle: handleFromProfile(profile?.tiktok_url ?? ''),
      windowDays: days,
      totals: { found: found.length, missing: missing.length, skipped: skipped.length },
      byDay: history.map((d) => ({
        day: d.day,
        checked: d.checked,
        found: d.found,
        skipped: d.skipped,
        pct: d.pct,
      })),
      byProduct: tally(rows, (r) => r.product),
      byVideoSize: tally(rows, (r) => sizeBand(r.views)),
      // The exact wording and how it fared. Empty until clicks recorded under
      // the new column accumulate; byProduct is what older clicks still support.
      byAssignedComment: withAssigned
        ? Object.keys(assignedTally)
            .map((text) => ({ text, ...assignedTally[text] }))
            .sort((a, b) => b.missing - a.missing)
            .slice(0, 40)
        : [],
      titleTermsOverrepresentedInMissing: titleTerms(rows),
      workingPaceSeconds: paceStats(rows),
      photoPosts: {
        found: found.filter((r) => r.isPhoto).length,
        missing: missing.filter((r) => r.isPhoto).length,
      },
    }

    const sampleOf = (r: PresenceLinkRow, status: string) => ({
      status,
      day: r.day,
      product: r.product,
      assigned: r.assigned,
      posted: status === 'found' ? r.text : undefined,
      title: r.title ? r.title.slice(0, TITLE_CHARS) : null,
      views: r.views,
      hearts: r.hearts,
      comments: r.comments,
    })
    const samples = [
      ...spread(found, SAMPLE).map((r) => sampleOf(r, 'found')),
      ...spread(missing, SAMPLE).map((r) => sampleOf(r, 'missing')),
      ...spread(skipped, 10).map((r) => sampleOf(r, 'skipped')),
    ]

    const system =
      'You are helping an admin work out why comments posted by one worker are ' +
      'not appearing on TikTok videos.\n\n' +
      'STATUS MEANINGS\n' +
      '  found   — the comment is visible on the video\n' +
      '  missing — the full comment list was read and the comment was not in it\n' +
      '  skipped — the comment list could not be read in full; proves nothing\n\n' +
      'A missing comment has several possible explanations. Weigh them against ' +
      'the evidence rather than assuming the first one:\n' +
      '  1. TikTok filtered or shadow-hid it — spam heuristics, text repeated ' +
      'across many videos, brand names or links in the comment, posting rate, or ' +
      'an account already under restriction.\n' +
      '  2. The video creator deleted it, or has keyword filters. Common when the ' +
      'video promotes a rival product.\n' +
      '  3. The worker never actually posted it.\n' +
      '  4. Nothing systematic — the read simply missed it.\n\n' +
      'EVIDENCE\n' +
      '`context` aggregates EVERY judged link in the window: per day, per ' +
      'product, per video size, the words over-represented in the titles of ' +
      'missing videos, the exact assigned comment text with its found/missing ' +
      'tally, and the working pace in seconds between consecutive clicks. ' +
      '`samples` are individual links you can quote.\n\n' +
      'WHAT TO LOOK FOR\n' +
      'Does missing cluster on particular DAYS? A clean run that stops dead ' +
      'points at the account, not the videos. Does it cluster on one PRODUCT, or ' +
      'one comment WORDING? That points at the text. Does it cluster on videos ' +
      'whose titles name rival tools or carry links? That points at creator ' +
      'moderation. Is the pace too fast for a human to have read the video and ' +
      'typed a comment? That points at explanation 3.\n\n' +
      'RULES\n' +
      'Quote the specific numbers, days, terms or phrases you reason from. Rank ' +
      'the explanations by how well the evidence supports each, and say plainly ' +
      'which ones this data cannot tell apart. Treat skipped as no evidence. If ' +
      'nothing separates found from missing, say so — a wrong pattern is worse ' +
      'than none, because the admin may block someone over it. End with the one ' +
      'thing the admin could most usefully check next.\n\n' +
      'Answer in under 300 words, plain prose, short paragraphs. Use NO markdown ' +
      'at all: no headings, no bullet lists, no ** for bold, no backticks. It is ' +
      'rendered as plain text and the symbols would show.'

    const user =
      `context = ${JSON.stringify(context)}\n\n` +
      (withAssigned === 0
        ? 'NOTE: the assigned comment text was not recorded for any of these clicks ' +
          '(the system only began storing it recently), so comment WORDING cannot ' +
          'be compared yet. The product each click drew from IS recorded, in ' +
          'byProduct.\n\n'
        : '') +
      `samples = ${JSON.stringify(samples)}`

    const { content, model } = await groqChat({
      temperature: 0.2,
      maxTokens: 1100,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })

    return NextResponse.json({
      ok: true,
      model,
      // Belt and braces on the no-markdown instruction: the panel renders plain
      // text, so a stray ** would show rather than be obeyed.
      analysis: content.trim().replace(/\*\*/g, '').replace(/^#+\s*/gm, ''),
      sampled: {
        aggregatedOver: rows.length,
        found: Math.min(found.length, SAMPLE),
        missing: Math.min(missing.length, SAMPLE),
        skipped: Math.min(skipped.length, 10),
        withAssigned,
        total: rows.length,
      },
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
