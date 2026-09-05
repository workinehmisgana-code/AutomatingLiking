import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import Guide from '@/components/Guide'
import Login from '@/components/Login'
import { getEffectivePlatformLimits } from '@/lib/db'
import {
  COMMENT_PAY_RATE,
  VIDEO_PAYMENT_BIRR,
  PROMO_PAY_BIRR,
  PROMO_DAILY_LIMIT_PER_PLATFORM,
  PROMO_DOWNLOAD_DAILY_LIMIT,
  REMINDER_CLICKS,
  CLICK_PLATFORMS,
  CLICK_PLATFORM_LABELS,
} from '@/lib/config'

export const dynamic = 'force-dynamic'

// The user guide. Rates and hourly limits are read from config + the database
// rather than written into the text, so the page can't drift out of date when an
// admin changes a quota or a pay rate.
export default async function GuidePage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />

  const { limits } = await getEffectivePlatformLimits().catch(() => ({
    limits: {} as Record<string, { limit: number; windowMs: number }>,
  }))
  const quotas = CLICK_PLATFORMS.map((p) => {
    const r = limits[p]
    return {
      platform: CLICK_PLATFORM_LABELS[p] || p,
      limit: r?.limit ?? 0,
      hours: Math.max(1, Math.round((r?.windowMs ?? 3600000) / 3600000)),
    }
  })

  return (
    <Guide
      quotas={quotas}
      commentRate={COMMENT_PAY_RATE}
      videoBirr={VIDEO_PAYMENT_BIRR}
      promoBirr={PROMO_PAY_BIRR}
      promoPerPlatform={PROMO_DAILY_LIMIT_PER_PLATFORM}
      promoDownloads={PROMO_DOWNLOAD_DAILY_LIMIT}
      reminderClicks={REMINDER_CLICKS}
    />
  )
}
