import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { deleteExtraProduct, listExtraProducts, saveExtraProduct } from '@/lib/genreStore'
import type { ExtraProduct } from '@/lib/genreRegistry'

export const dynamic = 'force-dynamic'

// Products added to a BUILT-IN genre (a new humanizer, say) — Admin → Genres.
//
//   GET                                   { products: ExtraProduct[] }
//   POST { id, genre, site, words, seeds[] }   add one, or save changes to one
//   DELETE { id }                         remove one (added products only)

async function requireAdmin(): Promise<boolean> {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  return isAdminEmail(session?.user?.email)
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ products: await listExtraProducts() })
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as Partial<ExtraProduct>
  const r = await saveExtraProduct(body)
  if (!r.ok) return NextResponse.json({ error: 'Not saved', problems: r.problems }, { status: 400 })
  return NextResponse.json({ ok: true, products: r.list })
}

export async function DELETE(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { id?: string }
  const id = String(body.id ?? '').trim()
  const products = await listExtraProducts()
  if (!products.some((p) => p.id === id)) {
    return NextResponse.json({ error: 'Only a product added here can be removed.' }, { status: 400 })
  }
  return NextResponse.json({ ok: true, products: await deleteExtraProduct(id) })
}
