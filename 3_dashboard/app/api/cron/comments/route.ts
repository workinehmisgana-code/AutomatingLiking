import { NextRequest, NextResponse } from 'next/server'
import { regenerateProducts } from '@/lib/commentGen'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Daily comment regeneration, triggered by Vercel Cron (see vercel.json).
// Vercel sends `Authorization: Bearer $CRON_SECRET`; we reject anything else so
// the endpoint can't be run by outsiders. The lazy 24h path in getFreshComments
// is the fallback if this cron isn't configured.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = req.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }
  try {
    const results = await regenerateProducts()
    return NextResponse.json({ ok: true, results })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
