import { redirect } from 'next/navigation'
import PromoClient from '@/components/PromoClient'
import { SHOW_OTHER_TASKS } from '@/lib/config'

// Static shell — renders instantly on navigation (no server round-trip). The
// per-user data is fetched client-side from /api/promo.
export default function PromoPage() {
  // Hidden with the other non-link tasks (env SHOW_OTHER_TASKS=false): an old
  // bookmark or a cached button lands back on the links instead.
  if (!SHOW_OTHER_TASKS) redirect('/')
  return <PromoClient />
}
