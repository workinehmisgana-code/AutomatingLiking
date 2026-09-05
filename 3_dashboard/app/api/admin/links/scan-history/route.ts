import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, PRODUCTS } from '@/lib/config'
import { getScanRuns, type ScanRun } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Every "Extract comments" press that read something, grouped by SCOPE.
//
// A scope is the cluster selection and filters that decided WHICH links were
// read. Two scopes cover different links, so their totals answer different
// questions and must never share a line: "our comments went from 40 to 55" only
// means anything if both numbers came from the same set of videos.
//
// Runs are returned oldest-first within each scope, which is the order a trend
// is read in.

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const runs = await getScanRuns(400)

    const byScope = new Map<string, { key: string; label: string; runs: ScanRun[] }>()
    for (const r of runs) {
      const g = byScope.get(r.scopeKey) ?? { key: r.scopeKey, label: r.scopeLabel, runs: [] }
      g.runs.push(r)
      byScope.set(r.scopeKey, g)
    }

    const scopes = Array.from(byScope.values())
      .map((g) => {
        // Oldest first: a trend reads left to right.
        const ordered = [...g.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        const last = ordered[ordered.length - 1]
        const first = ordered[0]
        return {
          key: g.key,
          label: g.label,
          runs: ordered,
          // The headline for the picker, so a scope can be chosen without
          // opening it: how many scans, and which way the number has moved.
          scans: ordered.length,
          latestAt: last.startedAt,
          latestOurs: last.ours,
          change: ordered.length > 1 ? last.ours - first.ours : null,
        }
      })
      // Most recently scanned scope first — that is the one just run.
      .sort((a, b) => b.latestAt.localeCompare(a.latestAt))

    return NextResponse.json({ scopes, products: PRODUCTS })
  } catch (e) {
    return NextResponse.json({ error: `Could not read scan history: ${String(e)}` }, { status: 500 })
  }
}
