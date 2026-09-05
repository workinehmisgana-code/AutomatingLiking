import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import PipelineReport from '@/components/PipelineReport'

export const dynamic = 'force-dynamic'

// What the automatic cycle has done, turn by turn.
//
// A page rather than a modal: this is the record of work that happens while
// nobody is watching, and it should be somewhere you can open directly and leave
// open, not something reachable only from another screen.
export default async function PipelinePage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl font-bold text-white">Automatic cycle</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Every six hours: look for new videos on the best channels, read comments on the
            clusters that matter, sort the new links, and rescore the pool.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/admin/links"
            className="text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-3 py-1.5 transition-colors"
          >
            🔗 Links
          </Link>
          <Link
            href="/admin"
            className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
          >
            Dashboard
          </Link>
        </div>
      </div>
      <PipelineReport />
    </div>
  )
}
