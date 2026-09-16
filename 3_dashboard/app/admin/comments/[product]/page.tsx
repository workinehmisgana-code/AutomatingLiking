import { headers } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { auth } from '@/lib/auth'
import {
  getProductCommentSettings,
  getCategoryComments,
  getCommentSetSizes,
  getActiveCommentProducts,
} from '@/lib/db'
import {
  isAdminEmail,
  isProduct,
  PRODUCTS,
  COMMENT_WORD_MIN,
  COMMENT_WORD_MAX,
  DEFAULT_COMMENT_STYLE,
  LINK_CATEGORIES,
} from '@/lib/config'
import Login from '@/components/Login'
import AdminProductComments from '@/components/AdminProductComments'

export const dynamic = 'force-dynamic'

export default async function AdminProductCommentsPage({
  params,
}: {
  params: { product: string }
}) {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')

  const product = params.product
  if (!isProduct(product)) notFound()

  // Read what's currently stored (no generation here — that only happens when
  // the admin clicks Regenerate).
  const { band, style } = await getProductCommentSettings(product, {
    min: COMMENT_WORD_MIN,
    max: COMMENT_WORD_MAX,
  }).catch(() => ({
    band: { min: COMMENT_WORD_MIN, max: COMMENT_WORD_MAX },
    style: DEFAULT_COMMENT_STYLE,
  }))
  // The three audience sets (lib/linkCategory.ts) — the only comments there
  // are. Each is read, never generated here: generation only happens when the
  // admin asks for it.
  const perCategory = await Promise.all(
    LINK_CATEGORIES.map(async (category) => {
      const row = await getCategoryComments(product, category).catch(() => null)
      return {
        category,
        comments: row?.comments ?? [],
        generatedAt: row?.generated_at ? new Date(row.generated_at).toISOString() : null,
        // The voices this set is rebuilt from. Empty means "the product's
        // current voice", which is what every set did before mixes were kept.
        voices: row?.voices ?? [],
      }
    })
  )

  // Every product, with how many comments it holds and whether it is being
  // served — enough for the switcher to say which are empty or switched off
  // without another page load to find out.
  const [sizes, active] = await Promise.all([
    getCommentSetSizes().catch(() => ({}) as Record<string, number>),
    getActiveCommentProducts().catch(() => [] as string[]),
  ])
  const activeSet = new Set(active)
  const products = PRODUCTS.map((id) => ({
    id,
    count: sizes[id] ?? 0,
    active: activeSet.has(id),
  }))

  return (
    <AdminProductComments
      product={product}
      wordMin={band.min}
      wordMax={band.max}
      style={style}
      perCategory={perCategory}
      products={products}
    />
  )
}
