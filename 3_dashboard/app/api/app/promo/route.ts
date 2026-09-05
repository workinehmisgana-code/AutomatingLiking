import { NextRequest, NextResponse } from 'next/server'
import { userIdFromApp } from '@/lib/appAuth'
import {
  getPromoVideosForUser,
  getPromoAccounts,
  getPromoDownloadInfo,
  getPromoTaskEnabled,
} from '@/lib/db'
import { getFreshPromo } from '@/lib/promoGen'
import { mandatoryPromoTags, PROMO_EXTRA_TAG_MAX, PROMO_PAY_BIRR, PROMO_PLATFORMS } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Native Repost & earn screen data (bearer-authed). Mirrors the /api/promo route.
export async function GET(req: NextRequest) {
  const userId = await userIdFromApp(req)
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!(await getPromoTaskEnabled().catch(() => true))) {
    return NextResponse.json({ taskEnabled: false })
  }

  const [allVideos, assignedProduct, accounts, downloadInfo] = await Promise.all([
    getPromoVideosForUser(userId).catch(() => []),
    Promise.resolve<string | null>(null),
    getPromoAccounts(userId).catch(() => ({}) as Record<string, string>),
    getPromoDownloadInfo(userId).catch(() => ({ usedToday: false, nextResetMs: 0 })),
  ])

  const platforms = PROMO_PLATFORMS.map((p) => ({ key: p.key, label: p.label }))

  if (Object.keys(accounts).length === 0) {
    return NextResponse.json({ taskEnabled: true, intro: true, product: assignedProduct, platforms, payBirr: PROMO_PAY_BIRR })
  }

  const videos = assignedProduct
    ? allVideos.filter((v) => v.product === assignedProduct || !v.product)
    : allVideos

  const captionProducts = assignedProduct
    ? [assignedProduct]
    : Array.from(new Set(videos.map((v) => v.product).filter((p): p is string => !!p)))

  const captionGroups = await Promise.all(
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
    platforms,
    payBirr: PROMO_PAY_BIRR,
    videos,
    captionGroups,
    downloadUsedToday: downloadInfo.usedToday,
    nextDownloadResetMs: downloadInfo.nextResetMs,
  })
}
