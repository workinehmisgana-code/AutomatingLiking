import AccountTaskClient from '@/components/AccountTaskClient'

// Static shell — renders instantly on navigation (no server round-trip). The
// per-user data is fetched client-side from /api/tasks/accounts.
export default function TasksPage() {
  return <AccountTaskClient />
}
