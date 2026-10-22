import { NextResponse } from 'next/server'
import { supportGuard } from '@/lib/support/auth'
import { looksLikePerson } from '@/lib/support/classify'
import { listInbox } from '@/lib/support/gmail'
import { activeProjects } from '@/lib/support/projects'
import { cached } from '@/lib/poolCache'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET — how many UNREAD emails from real people are waiting in the products'
 * support inboxes, for the button in the admin's top bar.
 *
 * "From real people" is the desk's own Person test (looksLikePerson): a
 * consumer mailbox or a human-shaped name, never a robot, a role address or a
 * mailing list — so Polar receipts and Google security notices do not count.
 *
 * Every admin page renders the bar, and reading five Gmail accounts takes
 * seconds, so the answer is cached for two minutes. `?fresh=1` skips it.
 */
type Unread = {
  total: number
  byProject: { id: string; label: string; unread: number }[]
  errors: string[]
}

async function countUnread(): Promise<Unread> {
  const projects = activeProjects()
  const settled = await Promise.allSettled(
    projects.map(async (p) => {
      // Every unread message in the inbox, not the unread ones among the
      // latest 60: a customer email is still waiting however much arrived after.
      const list = await listInbox(p.gmail!, 200, 'INBOX', { unseenOnly: true })
      return list.filter((m) => !m.seen && looksLikePerson(m.from, m.bulk)).length
    })
  )
  const byProject: Unread['byProject'] = []
  const errors: string[] = []
  settled.forEach((r, i) => {
    const p = projects[i]
    if (r.status === 'fulfilled') byProject.push({ id: p.id, label: p.label, unread: r.value })
    else errors.push(`${p.label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
  })
  return { total: byProject.reduce((n, p) => n + p.unread, 0), byProject, errors }
}

export async function GET(request: Request) {
  const denied = await supportGuard()
  if (denied) return denied
  const fresh = new URL(request.url).searchParams.get('fresh') === '1'
  try {
    const data = fresh ? await countUnread() : await cached('supportUnread', 2 * 60_000, countUnread)
    return NextResponse.json({ ok: true, ...data, configured: activeProjects().length })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
