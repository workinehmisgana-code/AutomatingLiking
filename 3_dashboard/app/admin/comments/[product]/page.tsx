import { headers } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { auth } from '@/lib/auth'
import { getGeneratedComments, getProductCommentSettings, getCategoryComments } from '@/lib/db'
import {
  isAdminEmail,
  isProduct,
  COMMENT_WORD_MIN,
  COMMENT_WORD_MAX,
  DEFAULT_COMMENT_STYLE,
  LINK_CATEGORIES,
} from '@/lib/config'
import { COMMENTS } from '@/lib/comments'
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
  // the admin clicks Regenerate). Fall back to the static theme bank so the
  // admin can see the source even before the first AI run.
  const [stored, settings] = await Promise.all([
    getGeneratedComments(product).catch(() => null),
    getProductCommentSettings(product, { min: COMMENT_WORD_MIN, max: COMMENT_WORD_MAX }).catch(
      () => ({
        band: { min: COMMENT_WORD_MIN, max: COMMENT_WORD_MAX },
        style: DEFAULT_COMMENT_STYLE,
      })
    ),
  ])
  const { band, style } = settings
  // The three audience sets (lib/linkCategory.ts). Each is read, never
  // generated here — generation only happens when the admin asks for it.
  const perCategory = await Promise.all(
    LINK_CATEGORIES.map(async (category) => {
      const row = await getCategoryComments(product, category).catch(() => null)
      return {
        category,
        comments: row?.comments ?? [],
        generatedAt: row?.generated_at ? new Date(row.generated_at).toISOString() : null,
      }
    })
  )

  const hasGenerated = !!stored && stored.comments.length > 0
  const comments = hasGenerated ? stored!.comments : COMMENTS[product] ?? []
  const generatedAt = stored?.generated_at ? new Date(stored.generated_at).toISOString() : null

  return (
    <AdminProductComments
      product={product}
      comments={comments}
      generatedAt={generatedAt}
      isGenerated={hasGenerated}
      wordMin={band.min}
      wordMax={band.max}
      style={style}
      perCategory={perCategory}
    />
  )
}
