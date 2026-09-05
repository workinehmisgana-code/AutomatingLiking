import VideoClient from '@/components/VideoClient'

// Static shell — renders instantly on navigation (no server round-trip). The
// per-user data is fetched client-side from /api/videos.
export default function VideosPage() {
  return <VideoClient />
}
