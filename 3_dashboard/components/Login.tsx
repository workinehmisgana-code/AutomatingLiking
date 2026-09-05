'use client'

import { useState } from 'react'
import { signIn } from '@/lib/auth-client'

export default function Login() {
  const [loading, setLoading] = useState(false)

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center max-w-sm w-full">
        <h1 className="text-2xl font-bold text-white">Video Links</h1>
        <p className="text-sm text-zinc-500 mt-2 mb-8">
          Sign in to see the links assigned to you. Links you open are removed so you
          never comment on the same one twice.
        </p>
        <button
          disabled={loading}
          onClick={async () => {
            setLoading(true)
            try {
              await signIn.social({ provider: 'google', callbackURL: '/' })
            } finally {
              setLoading(false)
            }
          }}
          className="w-full flex items-center justify-center gap-3 bg-white text-zinc-900 font-medium rounded-lg px-4 py-2.5 hover:bg-zinc-100 transition-colors disabled:opacity-50"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
            <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
            <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.4 14.97.5 12 .5A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 6.7 9.14 4.75 12 4.75Z" />
          </svg>
          {loading ? 'Redirecting…' : 'Sign in with Google'}
        </button>
      </div>
    </div>
  )
}
