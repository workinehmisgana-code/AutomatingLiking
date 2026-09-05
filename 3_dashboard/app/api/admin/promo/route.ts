import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, isProduct } from '@/lib/config'
import { createPromoVideo, deletePromoVideo, setPromoActive, setPromoLinkPaid } from '@/lib/db'

export const dynamic = 'force-dynamic'

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() })
  return isAdminEmail(session?.user?.email)
}

// POST — create a promo video record after its blob upload completes.
// { url, filename, size, product }  (titles + tags are AI-generated per product)
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const url = String(b?.url ?? '').trim()
  if (!url) return NextResponse.json({ error: 'Missing video url' }, { status: 400 })
  const product = String(b?.product ?? '')
  if (!isProduct(product)) return NextResponse.json({ error: 'Choose a product first' }, { status: 400 })
  try {
    const id = await createPromoVideo({
      url,
      filename: b?.filename ? String(b.filename) : null,
      size: b?.size != null ? Number(b.size) : null,
      product,
    })
    return NextResponse.json({ ok: true, id })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// PATCH — deactivate/reactivate a video, or mark a link paid/unpaid.
// { action: 'active', id, active } | { action: 'paid', id, paid }
export async function PATCH(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const id = Number(b?.id)
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Bad id' }, { status: 400 })
  try {
    if (b?.action === 'active') await setPromoActive(id, !!b.active)
    else if (b?.action === 'paid') await setPromoLinkPaid(id, !!b.paid)
    else return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

// DELETE — remove a promo video (blob + rows). { id }
export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  let b: Record<string, unknown>
  try {
    b = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const id = Number(b?.id)
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Bad id' }, { status: 400 })
  try {
    await deletePromoVideo(id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
