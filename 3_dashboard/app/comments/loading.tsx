import { PageSkeleton } from '@/components/PageLoader'

// Shown instantly on navigation (route Suspense boundary) so the page opens
// immediately with a skeleton while it loads.
export default function Loading() {
  return <PageSkeleton title="comments" variant="comments" />
}
