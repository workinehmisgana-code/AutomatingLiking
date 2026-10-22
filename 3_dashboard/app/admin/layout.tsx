import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import { getAdminGenre } from '@/lib/adminGenre'
import GenreSwitch from '@/components/GenreSwitch'
import UserMessagesPopup from '@/components/UserMessagesPopup'
import SupportInboxButton from '@/components/SupportInboxButton'
import { getUnreadReplies } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Every admin page, under the master genre switch.
 *
 * A LAYOUT so the switch cannot be forgotten on a page: there are ten of them,
 * and a genre control added to each one separately is exactly how five of them
 * ended up with five different local choices.
 *
 * The switch is shown only to an admin. Each page still does its own admin
 * check and redirect, so this is not the guard — it just keeps the bar off the
 * sign-in screen a non-admin is about to be sent to.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() }).catch(() => null)
  const admin = isAdminEmail(session?.user?.email)
  const genre = await getAdminGenre()
  // Users' messages sit in the genre bar, on every admin page, rather than in a
  // full-width row of their own on the home page.
  const unread = admin ? await getUnreadReplies().catch(() => []) : []
  return (
    <>
      {admin && (
        <GenreSwitch current={genre}>
          <UserMessagesPopup initial={unread} />
          {/* The products' support inboxes (the Refund Processor desk). */}
          <SupportInboxButton />
        </GenreSwitch>
      )}
      {children}
    </>
  )
}
