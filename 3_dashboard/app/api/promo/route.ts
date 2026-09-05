import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { profileGate } from '@/lib/profileGate'
import {
  getPromoVideosForUser,
  getPromoAccounts,
  getPromoDownloadInfo,
  isEmailBlocked,
  getPromoTaskEnabled,
} from '@/lib/db'
import { getFreshPromo } from '@/lib/promoGen'
import { mandatoryPromoTags, PROMO_EXTRA_TAG_MAX } from '@/lib/config'
import type { CaptionGroup } from '@/components/PromoTask'

export const dynamic = 'force-dynamic'

// The data the /promo page needs, loaded client-side so navigation is instant.
// `intro: true` means the user hasn't added their dedicated accounts yet.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await profileGate(session.user.id)
  if (gate) return gate
  if (await isEmailBlocked(session.user.email).catch(() => false)) {
    return NextResponse.json({ error: 'Account blocked', blocked: true }, { status: 403 })
  }

  // Task switched off by the admin: return early rather than serving videos the
  // user could download but never submit (every mutating promo route is blocked).
  if (!(await getPromoTaskEnabled().catch(() => true))) {
    return NextResponse.json({ taskEnabled: false })
  }

  const [allVideos, assignedProduct, accounts, downloadInfo] = await Promise.all([
    getPromoVideosForUser(session.user.id).catch(() => []),
    Promise.resolve<string | null>(null),
    getPromoAccounts(session.user.id).catch(() => ({})),
    getPromoDownloadInfo(session.user.id).catch(() => ({ usedToday: false, nextResetMs: 0 })),
  ])

  if (Object.keys(accounts).length === 0) {
    return NextResponse.json({ taskEnabled: true, intro: true, product: assignedProduct })
  }

  const videos = assignedProduct
    ? allVideos.filter((v) => v.product === assignedProduct || !v.product)
    : allVideos

  const captionProducts = assignedProduct
    ? [assignedProduct]
    : Array.from(new Set(videos.map((v) => v.product).filter((p): p is string => !!p)))

  const captionGroups: CaptionGroup[] = await Promise.all(
    captionProducts.map(async (product) => {
      const promo = await getFreshPromo(product).catch(() => ({
        titles: [] as string[],
        extraTags: [] as string[],
        generatedAt: null,
      }))
      const requiredTags = mandatoryPromoTags(product)
      const extra = promo.extraTags.slice(0, PROMO_EXTRA_TAG_MAX)
      const tagLine = [requiredTags, extra.join(' ')].filter(Boolean).join(' ')
      return {
        product,
        requiredTags,
        captions: promo.titles.map((title) => ({ title, text: `${title}\n\n${tagLine}` })),
      }
    })
  )

  return NextResponse.json({
    taskEnabled: true,
    intro: false,
    product: assignedProduct,
    videos,
    captionGroups,
    downloadUsedToday: downloadInfo.usedToday,
    nextDownloadResetMs: downloadInfo.nextResetMs,
  })
}
