import PromoClient from '@/components/PromoClient'

// Static shell — renders instantly on navigation (no server round-trip). The
// per-user data is fetched client-side from /api/promo.
export default function PromoPage() {
  return <PromoClient />
}
