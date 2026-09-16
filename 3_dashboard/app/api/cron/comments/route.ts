import { NextRequest, NextResponse } from 'next/server'
import { regenerateCategoryProducts } from '@/lib/commentGen'
import { getActiveCommentProducts } from '@/lib/db'
import { isProduct, type Product } from '@/lib/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Daily comment regeneration, triggered by Vercel Cron (see vercel.json).
// Vercel sends `Authorization: Bearer $CRON_SECRET`; we reject anything else so
// the endpoint can't be run by outsiders. The lazy 24h path in
// getFreshCategoryComments is the fallback if this cron isn't configured — but
// that one makes a real user's click wait on an LLM call, which is exactly what
// this exists to avoid.
//
// It refreshes the AUDIENCE sets, which are the only comments anyone is served.
// It used to refresh the audience-neutral set instead, so every night paid for a
// rewrite nobody read while the sets users actually get went stale.
//
// ACTIVE PRODUCTS ONLY. Three audiences per product is three LLM calls, and
// rewriting products that are switched off spends the tokens-per-minute budget
// on comments that cannot be served — the ones that can then fail.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }
  try {
    // getActiveCommentProducts already defaults to every non-deactivated product
    // when the admin has not chosen a subset, and returns an empty list only
    // when they have explicitly switched everything off — in which case there is
    // nothing being served and nothing worth rewriting.
    const products = (await getActiveCommentProducts().catch(() => [] as string[])).filter(
      isProduct
    ) as Product[]
    const results = await regenerateCategoryProducts(products)
    return NextResponse.json({ ok: true, products, results })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
