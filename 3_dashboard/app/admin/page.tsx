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
  getMinAccountAgeDays,
  getPayAdjustments,
  getAutoBlockCounts,
  getTiktokAccounts,
  getAllGenrePauses,
} from '@/lib/db'
import { isAdminEmail } from '@/lib/config'
import { getAdminGenre } from '@/lib/adminGenre'
import Login from '@/components/Login'
import AdminDashboard from '@/components/AdminDashboard'

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

  // The master genre switch. Read once, here, and handed to every query and
  // to the page, so nothing on the screen can be about a different genre from
  // the number beside it.
  const genre = await getAdminGenre()

  const [
    data, pendingByUser, apk, appVersions, videoTaskEnabled, promoTaskEnabled,
    presence, presenceHistory, tiktokAccounts, guideVideos, referralByUser,
  ] = await Promise.all([
    getAdminData(genre),
    getAllPendingPay().catch(() => ({})),
    getApk().catch(() => null),
    getUserAppVersions().catch(() => ({})),
    getVideoTaskEnabled().catch(() => true),
    getPromoTaskEnabled().catch(() => true),
    // Comment-presence: the badge average, and the last 7 days for the
    // expanded view. Both are cheap aggregate reads.
    // EVERY GENRE, whichever one the switch is on. Verify, Verify all and the
    // auto-block rules judge a worker's last links whatever genre they came
    // from, so the presence shown beside those buttons has to be the same
    // all-genre measure — cut to one genre it read "Not scored yet" in a genre
    // the worker had barely touched, right after a check that scored them.
    getPresenceAverages().catch(() => ({})),
    getPresenceHistory(7).catch(() => ({})),
    // The numeric TikTok id behind each handle, which dates the account. Picked
    // up for free by presence checks; one small table.
    getTiktokAccounts().catch(() => ({})),
    getGuideVideos().catch(() => []),
    // What users have written and nobody has answered. Server-rendered with
    // the rest of the page so it is on screen with the first paint rather than
    // appearing a second later, over whatever the admin had started reading.
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
      {/* Users' messages are in the genre bar (app/admin/layout.tsx). */}
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
        minAgeDays={await getMinAccountAgeDays().catch(() => 90)}
        payAdjustments={await getPayAdjustments().catch(() => ({}))}
        autoBlockCounts={await getAutoBlockCounts().catch(() => ({}))}
        genrePauses={await getAllGenrePauses().catch(() => ({}))}
        genre={genre}
      />
    </>
  )
}
