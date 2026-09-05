import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { promises as fs } from 'fs'
import path from 'path'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getTiktokVerifyList, setUserValid, clearUserValidity } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60 // just reads a local JSON file and matches — fast

function usernameFromTiktokUrl(url: string): string | null {
  const m = (url || '').match(/@([^/?#\s]+)/)
  return m?.[1] ? m[1].toLowerCase() : null
}

// Normalise a commenter handle from comments_extracted.json ("@Name" → "name").
function normUser(u: string): string {
  return (u || '').trim().replace(/^@+/, '').toLowerCase()
}

type ExtractedEntry = { url?: string; comments?: { user?: string }[] }

// POST — verify EVERY user with pending birr by looking their TikTok @username up
// in 2_comment_automation/comments_extracted.json (the corpus of comments already
// pulled from Freer). No browser, no captcha — just a fast in-memory match. Each
// user found in the corpus is marked valid for 7 days; the rest are marked
// unverified.
export async function POST() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Locate and load the extracted-comments corpus.
  const dir = process.env.VERIFIER_DIR || path.resolve(process.cwd(), '..', '2_comment_automation')
  const file = process.env.COMMENTS_EXTRACTED_FILE || path.join(dir, 'comments_extracted.json')
  let data: ExtractedEntry[]
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    data = parsed as ExtractedEntry[]
  } catch (e) {
    return NextResponse.json(
      {
        error: `Could not read the extracted comments file at ${file}. Run extract_comments.py in 2_comment_automation first (it produces comments_extracted.json). Details: ${String((e as Error)?.message || e)}`,
      },
      { status: 400 }
    )
  }

  // Build: normalised commenter handle → the first video URL it appeared in.
  const commenters = new Map<string, string>()
  let totalComments = 0
  for (const entry of data) {
    const url = String(entry?.url ?? '')
    for (const c of entry?.comments ?? []) {
      const nu = normUser(String(c?.user ?? ''))
      if (!nu) continue
      totalComments++
      if (!commenters.has(nu)) commenters.set(nu, url)
    }
  }

  // Check EVERY user who has a TikTok profile link (→ a @username to look up).
  const list = await getTiktokVerifyList()
  const users = list
    .map((u) => ({ userId: u.userId, name: u.name, username: usernameFromTiktokUrl(u.tiktokUrl) }))
    .filter((u) => !!u.username)
  if (users.length === 0) {
    return NextResponse.json({
      ok: true,
      total: 0,
      checked: 0,
      found: 0,
      results: [],
      note: 'No users with a TikTok profile link.',
    })
  }

  type Res = { userId: string; username: string; name?: string; found: boolean; matched_link: string | null }
  const results: Res[] = []
  const marks: Promise<unknown>[] = []
  let found = 0

  process.stderr.write(
    `[verify-all] scanning ${commenters.size} unique commenter(s) from ${totalComments} comment(s) in ${data.length} link(s)\n`
  )

  for (const u of users) {
    const matched = u.username ? commenters.get(u.username) ?? null : null
    const isFound = !!matched
    const who = `${u.name || '(no name)'} (@${u.username})`
    results.push({ userId: u.userId, username: u.username!, name: u.name, found: isFound, matched_link: matched })
    if (isFound) {
      found++
      process.stderr.write(`[verify-all] ✓ ${who} → VALID (${matched})\n`)
      marks.push(setUserValid(u.userId, 7).catch(() => {}))
    } else {
      process.stderr.write(`[verify-all] ✗ ${who} → UNVERIFIED\n`)
      marks.push(clearUserValidity(u.userId).catch(() => {}))
    }
  }

  await Promise.all(marks) // ensure all validity writes finished before responding
  return NextResponse.json({ ok: true, total: users.length, checked: results.length, found, results })
}
