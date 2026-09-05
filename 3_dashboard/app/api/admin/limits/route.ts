import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, CLICK_PLATFORMS } from '@/lib/config'
import {
  getPlatformLimits,
  setPlatformLimit,
  setPlatformEnabled,
  setPlatformRetireEnabled,
} from '@/lib/db'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// GET — every platform's { limit, windowMs, enabled, retireEnabled }. There is no
// global master switch: each platform is governed entirely by its own two flags.
export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const limits = await getPlatformLimits()
    return NextResponse.json({ limits })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// POST — one of (all are per-platform; `platform` is always required):
//   { platform, enabled }              flip that platform's HOURLY quota switch
//   { platform, retireEnabled }        flip that platform's RETIREMENT switch
//   { platform, limit, windowMs }      save that platform's quota + wait window
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const platformArg = String(b?.platform ?? '').trim()
  const knownPlatform = CLICK_PLATFORMS.includes(platformArg as (typeof CLICK_PLATFORMS)[number])

  // Per-platform RETIREMENT toggle — { platform, retireEnabled }.
  if (platformArg && typeof b?.retireEnabled === 'boolean') {
    if (!knownPlatform) return NextResponse.json({ error: 'Unknown platform' }, { status: 400 })
    try {
      await setPlatformRetireEnabled(platformArg, b.retireEnabled)
      return NextResponse.json({ ok: true, limits: await getPlatformLimits() })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // Per-platform HOURLY-quota toggle — { platform, enabled }.
  if (platformArg && typeof b?.enabled === 'boolean') {
    if (!knownPlatform) return NextResponse.json({ error: 'Unknown platform' }, { status: 400 })
    try {
      await setPlatformEnabled(platformArg, b.enabled)
      return NextResponse.json({ ok: true, limits: await getPlatformLimits() })
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 500 })
    }
  }

  // Anything else must be a limit/window save, which is also per-platform.
  const platform = platformArg
  const limit = Math.trunc(Number(b?.limit))
  const windowMs = Math.trunc(Number(b?.windowMs))
  if (!knownPlatform) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 400 })
  }
  if (!Number.isFinite(limit) || !Number.isFinite(windowMs) || windowMs < 1000) {
    return NextResponse.json({ error: 'Invalid limit or window' }, { status: 400 })
  }
  try {
    await setPlatformLimit(platform, limit, windowMs)
    return NextResponse.json({ ok: true, limits: await getPlatformLimits() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
