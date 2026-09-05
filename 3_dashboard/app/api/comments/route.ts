import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import { getActiveCommentProducts, isEmailBlocked } from '@/lib/db'
import { getFreshComments } from '@/lib/commentGen'
import { COMMENT_SHUFFLE_MS } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Deterministic shuffle seeded by an integer (same seed → same order).
function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0
  const rand = () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// The data the /comments page needs, loaded client-side so navigation is instant.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(session.user.id)
  if (gate) return gate
  if (await isEmailBlocked(session.user.email).catch(() => false)) {
    return NextResponse.json({ error: 'Account blocked', blocked: true }, { status: 403 })
  }

  // Users are not assigned to a product — they work for all of them. Everyone
  // gets the same cross-product pool the app uses: every ACTIVE product's
  // comments, flattened and de-duped. `commentProducts` is index-aligned with
  // `comments` so the caller can report which product's comment it served.
  const products = await getActiveCommentProducts().catch(() => [] as string[])
  const lists = await Promise.all(
    products.map((p) => getFreshComments(p).then((r) => r.comments).catch(() => [] as string[]))
  )
  const seen = new Set<string>()
  const pool: { text: string; product: string }[] = []
  for (let i = 0; i < lists.length; i++) {
    for (const c of lists[i]) {
      const t = String(c || '').trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        pool.push({ text: t, product: products[i] })
      }
    }
  }

  // Shuffle text and product together so they stay paired.
  const bucket = Math.floor(Date.now() / COMMENT_SHUFFLE_MS)
  const shuffled = seededShuffle(pool, bucket)
  return NextResponse.json({
    product: null,
    pooled: true,
    products,
    comments: shuffled.map((c) => c.text),
    commentProducts: shuffled.map((c) => c.product),
    generatedAt: null,
  })
}
