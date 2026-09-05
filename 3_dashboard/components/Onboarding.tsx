'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/auth-client'
import { validateAllProfileLinks } from '@/lib/config'
import type { UserProfile } from '@/lib/db'

// Products a new user can pick to work on (deactivated ones are not offered).

export default function Onboarding({
  initial,
  email,
  suggestedName,
}: {
  initial: UserProfile | null
  email: string
  suggestedName: string
}) {
  const router = useRouter()
  const [name, setName] = useState(initial?.name ?? suggestedName ?? '')
  const [bank, setBank] = useState(initial?.bank_account ?? '')
  const [tiktok, setTiktok] = useState(initial?.tiktok_url ?? '')
  const [youtube, setYoutube] = useState(initial?.youtube_url ?? '')
  const [instagram, setInstagram] = useState(initial?.instagram_url ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim()) return setError('Please enter your name.')
    if (!bank.trim()) return setError('Please enter your bank account number.')
    if (!tiktok.trim()) return setError('Please enter your TikTok profile link.')
    const linkError = validateAllProfileLinks({
      tiktok_url: tiktok,
      youtube_url: youtube,
      instagram_url: instagram,
    })
    if (linkError) return setError(linkError)
    setSaving(true)
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          bank_account: bank,
          tiktok_url: tiktok,
          youtube_url: youtube,
          instagram_url: instagram,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setError(d.error || 'Could not save. Please try again.')
        return
      }
      router.replace('/')
      router.refresh()
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500'
  const labelCls = 'block text-sm text-zinc-300 mb-1'

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-md">
        <div className="flex items-start justify-between gap-4 mb-1">
          <h1 className="text-xl font-bold text-white">Complete your profile</h1>
          <button
            type="button"
            onClick={async () => {
              await signOut()
              window.location.href = '/'
            }}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Sign out
          </button>
        </div>
        <p className="text-sm text-zinc-500 mb-6">
          We need a few details before you start. This is saved to your account
          {email ? ` (${email})` : ''} and you can change it later.
        </p>

        <div className="space-y-4">
          <div>
            <label className={labelCls}>Full name <span className="text-emerald-500">*</span></label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
          </div>

          <div>
            <label className={labelCls}>Bank account number <span className="text-emerald-500">*</span></label>
            <input
              className={inputCls}
              value={bank}
              onChange={(e) => setBank(e.target.value)}
              placeholder="For your payouts"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>

          <div className="pt-2">
            <p className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
              Accounts you comment from
            </p>
            <p className="text-xs text-zinc-500 mb-3">
              TikTok is required to start; YouTube and Instagram are optional. Enter each account&apos;s
              profile link (a valid platform URL). Each link can only be registered by one person.
            </p>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>TikTok profile link <span className="text-emerald-500">*</span></label>
                <input className={inputCls} value={tiktok} onChange={(e) => setTiktok(e.target.value)} placeholder="https://www.tiktok.com/@you" inputMode="url" />
              </div>
              <div>
                <label className={labelCls}>YouTube channel link <span className="text-zinc-600">(optional)</span></label>
                <input className={inputCls} value={youtube} onChange={(e) => setYoutube(e.target.value)} placeholder="https://www.youtube.com/@you" inputMode="url" />
              </div>
              <div>
                <label className={labelCls}>Instagram profile link <span className="text-zinc-600">(optional)</span></label>
                <input className={inputCls} value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="https://www.instagram.com/you" inputMode="url" />
              </div>
            </div>
          </div>

        </div>

        {error && <p className="text-sm text-red-400 mt-4">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="mt-6 w-full bg-emerald-600 text-white font-medium rounded-lg px-4 py-2.5 hover:bg-emerald-500 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </form>
    </div>
  )
}
