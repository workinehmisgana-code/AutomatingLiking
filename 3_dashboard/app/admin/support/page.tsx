import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { isAdminEmail } from '@/lib/config'
import Login from '@/components/Login'
import Dashboard from '@/components/support/Dashboard'
import { projectSummaries } from '@/lib/support/projects'
import './support.css'

export const dynamic = 'force-dynamic'

// The products' support inboxes, merged — the Refund Processor's Support Desk,
// inside the admin. Read mail, look the customer up in billing and the
// product's database, refund, cancel, delete, and reply.
export default async function SupportPage() {
  let session
  try {
    session = await auth.api.getSession({ headers: await headers() })
  } catch {
    session = null
  }
  if (!session) return <Login />
  if (!isAdminEmail(session.user.email)) redirect('/')

  return (
    <Dashboard
      projects={projectSummaries()}
      groqReady={Boolean(process.env.GEMINI_API_KEY?.trim() || process.env.GROQ_API_KEY?.trim())}
    />
  )
}
