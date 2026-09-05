import CommentsClient from '@/components/CommentsClient'

// Static shell — renders instantly on navigation (no server round-trip). The
// per-user data is fetched client-side from /api/comments.
export default function CommentsPage() {
  return <CommentsClient />
}
