import { NextRequest, NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail, isProduct } from '@/lib/config'
import { regeneratePromo } from '@/lib/promoGen'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST { product } — regenerate the AI caption titles + extra tags for a product.
export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  let product = ''
  try {
    product = String((await req.json())?.product ?? '')
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!isProduct(product)) return NextResponse.json({ error: 'Unknown product' }, { status: 400 })
  try {
    const count = await regeneratePromo(product)
    return NextResponse.json({ ok: true, count })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
