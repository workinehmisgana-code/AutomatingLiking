'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/auth-client'
import { ADMIN_TELEGRAM } from '@/lib/config'

// Shown to a user blocked for a CORRECTABLE reason ('bank' or 'tiktok'). They
// enter a new bank account / TikTok link; on success the block lifts and they're
// let into the dashboard.
export default function BlockedRemediation({
  reason,
  email,
}: {
  reason: 'bank' | 'tiktok'
  email?: string
}) {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const isBank = reason === 'bank'
  const title = isBank ? 'Your bank account needs updating' : 'Your TikTok account needs updating'
  const explain = isBank
    ? 'Your account was blocked because the bank account number you gave appears to be incorrect. Enter a new, correct bank account number to continue.'
    : 'Your account was blocked because your TikTok account’s visibility is restricted. Enter a different TikTok profile link (a public account) to continue.'
  const label = isBank ? 'New bank account number' : 'New TikTok profile link'
  const placeholder = isBank ? 'Correct account number' : 'https://www.tiktok.com/@you'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!value.trim()) return setError(isBank ? 'Enter your bank account number.' : 'Enter your TikTok profile link.')
    setSaving(true)
    try {
      const res = await fetch('/api/profile/remediate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d?.error || 'Could not update. Please try again.')
        return
      }
      // Unblocked — go to the dashboard.
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

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-md">
        <p className="text-4xl mb-3 text-center">{isBank ? '🏦' : '🎯'}</p>
        <h1 className="text-xl font-bold text-white text-center">{title}</h1>
        <p className="text-sm text-zinc-400 mt-3">{explain}</p>

        <div className="mt-6">
          <label className="block text-sm text-zinc-300 mb-1">
            {label} <span className="text-emerald-500">*</span>
          </label>
          <input
            className={inputCls}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            inputMode={isBank ? 'numeric' : 'url'}
            autoComplete="off"
          />
        </div>

        {error && <p className="text-sm text-red-400 mt-4">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="mt-6 w-full bg-emerald-600 text-white font-medium rounded-lg px-4 py-2.5 hover:bg-emerald-500 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save and continue'}
        </button>

        <div className="mt-6 flex items-center justify-between text-xs">
          <a
            href={`https://t.me/${ADMIN_TELEGRAM}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 hover:text-sky-300"
          >
            Need help? Contact admin on Telegram
          </a>
          <button
            type="button"
            onClick={async () => {
              await signOut()
              window.location.href = '/'
            }}
            className="text-zinc-500 hover:text-zinc-300"
          >
            Sign out
          </button>
        </div>
        {email ? <p className="text-[11px] text-zinc-600 mt-3 text-center">{email}</p> : null}
      </form>
    </div>
  )
}
