'use client'

import { useEffect, useState } from 'react'
import { signIn, useSession } from '@/lib/auth-client'
import { ADMIN_TELEGRAM } from '@/lib/config'

// The Android bubble app opens this page in the browser. After Google sign-in we
// mint a per-user app token and hand it back via the nextbubble:// deep link.
export default function AppLogin() {
  const { data: session, isPending } = useSession()
  const [status, setStatus] = useState('')
  const [deepLink, setDeepLink] = useState<string | null>(null)
  const [blockedMsg, setBlockedMsg] = useState<string | null>(null)
  // Set when the token was refused because onboarding is unfinished — a
  // different situation from a block, and one the user can fix themselves.
  const [needsProfile, setNeedsProfile] = useState(false)

  useEffect(() => {
    if (isPending || !session) return
    let cancelled = false
    ;(async () => {
      setStatus('Connecting the app…')
      try {
        const res = await fetch('/api/app/token', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok && d?.token) {
          const link = `nextbubble://auth?token=${encodeURIComponent(d.token)}`
          setDeepLink(link)
          setStatus('Opening the app…')
          window.location.href = link
        } else if (d?.needsProfile) {
          // Missing bank account or TikTok link — send them to onboarding.
          setNeedsProfile(true)
          setBlockedMsg(d?.error || 'Finish your profile before using the app.')
          setStatus('')
        } else if (res.status === 403 || d?.blocked) {
          // Blocked account — can't get an app token. Point them to the dashboard
          // (where a bank/TikTok block can be fixed) and the admin on Telegram.
          setBlockedMsg(d?.error || 'Your account is blocked.')
          setStatus('')
        } else {
          setStatus('Could not create an app token. Please try again.')
        }
      } catch {
        if (!cancelled) setStatus('Network error. Please try again.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session, isPending])

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#0a0a0a]">
      <div className="text-center max-w-sm w-full">
        <h1 className="text-2xl font-bold text-white">Next Bubble</h1>
        <p className="text-sm text-zinc-500 mt-2 mb-8">
          Sign in with the same Google account you use on the dashboard. The app will
          then load the links assigned to you.
        </p>

        {blockedMsg ? (
          <div>
            <p className="text-4xl mb-3">{needsProfile ? '📝' : '🚫'}</p>
            <p className={`text-sm ${needsProfile ? 'text-amber-300' : 'text-red-300'}`}>
              {blockedMsg}
            </p>
            <a
              href={needsProfile ? '/onboarding' : '/'}
              className="mt-5 inline-block w-full bg-emerald-600 text-white font-medium rounded-lg px-4 py-2.5 hover:bg-emerald-500 transition-colors"
            >
              {needsProfile ? 'Finish my profile' : 'Open the dashboard'}
            </a>
            <a
              href={`https://t.me/${ADMIN_TELEGRAM}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-block text-sm text-sky-400 hover:text-sky-300"
            >
              Contact admin on Telegram
            </a>
          </div>
        ) : isPending ? (
          <p className="text-sm text-zinc-500">Checking…</p>
        ) : !session ? (
          <button
            onClick={() => signIn.social({ provider: 'google', callbackURL: '/app-login' })}
            className="w-full flex items-center justify-center gap-3 bg-white text-zinc-900 font-medium rounded-lg px-4 py-2.5 hover:bg-zinc-100 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
              <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
              <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.4 14.97.5 12 .5A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 6.7 9.14 4.75 12 4.75Z" />
            </svg>
            Sign in with Google
          </button>
        ) : (
          <>
            <p className="text-sm text-emerald-400">{status}</p>
            {deepLink && (
              <a href={deepLink} className="text-xs text-zinc-500 underline mt-4 inline-block">
                Tap here if the app didn&apos;t open
              </a>
            )}
          </>
        )}
      </div>
    </div>
  )
}
