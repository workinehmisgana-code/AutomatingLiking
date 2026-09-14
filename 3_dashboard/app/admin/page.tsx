import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import {
  getAdminData,
  getAllPendingPay,
  getApk,
  getGuideVideos,
  getUserAppVersions,
  getVideoTaskEnabled,
  getPromoTaskEnabled,
  getPresenceAverages,
  getPresenceHistory,
  getTiktokAccounts,
} from '@/lib/db'
import { isAdminEmail } from '@/lib/config'
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

  const [
    data, pendingByUser, apk, appVersions, videoTaskEnabled, promoTaskEnabled,
    presence, presenceHistory, tiktokAccounts, guideVideos,
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
  ])

  return (
    <AdminDashboard
      data={data}
      adminEmail={session.user.email ?? ''}
      pendingByUser={pendingByUser}
      apk={apk}
      appVersions={appVersions}
      videoTaskEnabled={videoTaskEnabled}
      promoTaskEnabled={promoTaskEnabled}
      presence={presence}
      presenceHistory={presenceHistory}
      tiktokAccounts={tiktokAccounts}
      guideVideos={guideVideos}
    />
  )
}
