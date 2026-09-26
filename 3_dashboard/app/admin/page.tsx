import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import {
  getAdminData,
  getAllPendingPay,
  getAllReferralEarnings,
  assignMissingReferralCodes,
  getApk,
  getGuideVideos,
  getUserAppVersions,
  getVideoTaskEnabled,
  getPromoTaskEnabled,
  getPresenceAverages,
  getPresenceHistory,
  getTiktokAccounts,
  getUnreadReplies,
} from '@/lib/db'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import AdminDashboard from '@/components/AdminDashboard'
import UserMessagesPopup from '@/components/UserMessagesPopup'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')

  const [
    data, pendingByUser, apk, appVersions, videoTaskEnabled, promoTaskEnabled,
    presence, presenceHistory, tiktokAccounts, guideVideos, unreadReplies, referralByUser,
  ] = await Promise.all([
    getAdminData(),
    getAllPendingPay().catch(() => ({})),
    getApk().catch(() => null),
    getUserAppVersions().catch(() => ({})),
    getVideoTaskEnabled().catch(() => true),
    getPromoTaskEnabled().catch(() => true),
    // Comment-presence: the badge average, and the last 7 days for the
    // expanded view. Both are cheap aggregate reads.
    getPresenceAverages().catch(() => ({})),
    getPresenceHistory(7).catch(() => ({})),
    // The numeric TikTok id behind each handle, which dates the account. Picked
    // up for free by presence checks; one small table.
    getTiktokAccounts().catch(() => ({})),
    getGuideVideos().catch(() => []),
    // What users have written and nobody has answered. Server-rendered with
    // the rest of the page so it is on screen with the first paint rather than
    // appearing a second later, over whatever the admin had started reading.
    getUnreadReplies().catch(() => []),
    // Who referred whom, and what it has earned. Also the moment every user who
    // registered before referrals existed gets a code of their own — their own
    // dashboard assigns it on their next visit, but the admin should not be
    // looking at blank codes until each of them happens to log in.
    assignMissingReferralCodes()
      .catch(() => 0)
      .then(() => getAllReferralEarnings())
      .catch(() => ({})),
  ])

  return (
    <>
      {/* Over everything, before anything else is read. A message from a user
          had no home before this: it lived inside that user's own card, three
          hundred cards down a list sorted by clicks, and could only be found by
          somebody who already knew it was there. */}
      <UserMessagesPopup initial={unreadReplies} />
      <AdminDashboard
        data={data}
        adminEmail={session.user.email ?? ''}
        pendingByUser={pendingByUser}
        referralByUser={referralByUser}
        apk={apk}
        appVersions={appVersions}
        videoTaskEnabled={videoTaskEnabled}
        promoTaskEnabled={promoTaskEnabled}
        presence={presence}
        presenceHistory={presenceHistory}
        tiktokAccounts={tiktokAccounts}
        guideVideos={guideVideos}
      />
    </>
  )
}
