'use client'

import { signOut } from '@/lib/auth-client'
import { ADMIN_TELEGRAM } from '@/lib/config'

// Shown to a signed-in user whose account the admin has blocked. They cannot use
// the dashboard; their only path forward is to contact the admin on Telegram.
export default function Blocked({ email }: { email?: string }) {
  const handle = ADMIN_TELEGRAM
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md text-center">
        <p className="text-5xl mb-4">🚫</p>
        <h1 className="text-xl font-bold text-white">Your account is blocked</h1>
        <p className="text-sm text-zinc-400 mt-3">
          You can no longer access this dashboard
          {email ? (
            <>
              {' '}
              with <span className="text-zinc-300">{email}</span>
            </>
          ) : null}
          . If you think this is a mistake, contact the admin on Telegram.
        </p>

        <a
          href={`https://t.me/${handle}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex items-center justify-center gap-2 bg-sky-600 hover:bg-sky-500 text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
        >
          ✈️ Contact admin on Telegram (@{handle})
        </a>

        <div className="mt-6">
          <button
            onClick={async () => {
              await signOut()
              window.location.href = '/'
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
