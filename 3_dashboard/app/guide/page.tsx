import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import Guide from '@/components/Guide'
import { getGuideVideos } from '@/lib/db'
import {
  COMMENT_PAY_RATE,
  VIDEO_PAYMENT_BIRR,
  PROMO_PAY_BIRR,
  PROMO_DAILY_LIMIT_PER_PLATFORM,
  PROMO_DOWNLOAD_DAILY_LIMIT,
  REMINDER_CLICKS,
  HOURLY_LINK_LIMIT,
  SITE_URL,
} from '@/lib/config'

export const dynamic = 'force-dynamic'

// The user guide. Pay rates come from config rather than being written into the
// text, so the page can't drift out of date when a rate changes.
//
// PUBLIC — deliberately no sign-in check. This is the page you send someone
// BEFORE they join: it explains what the work is and what it pays, and putting
// it behind a login meant nobody could read it until after they had signed up.
// It shows only rates and instructions; no link, no user data, nothing
// about the pool.
export default async function GuidePage() {
  // Not a gate — only so the page knows whether to offer "back to your links"
  // or "sign in". A failure here reads as signed out, which is the safe default.
  const session = await auth.api
    .getSession({ headers: await headers() })
    .catch(() => null)

  const guideVideos = await getGuideVideos().catch(() => [])

  return (
    <Guide
      linksPerPage={HOURLY_LINK_LIMIT}
      commentRate={COMMENT_PAY_RATE}
      videoBirr={VIDEO_PAYMENT_BIRR}
      promoBirr={PROMO_PAY_BIRR}
      promoPerPlatform={PROMO_DAILY_LIMIT_PER_PLATFORM}
      promoDownloads={PROMO_DOWNLOAD_DAILY_LIMIT}
      reminderClicks={REMINDER_CLICKS}
      videos={guideVideos}
      signedIn={!!session}
      startUrl={SITE_URL}
    />
  )
}
