'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { validateAllProfileLinks } from '@/lib/config'
import type { UserProfile } from '@/lib/db'

// Lets a signed-in user change the account profile links (TikTok / YouTube /
// Instagram) plus their payout bank account number that they submitted at
// registration. Posts the WHOLE profile back to /api/profile (which validates
// links, rejects duplicates already owned by someone else, and re-verifies),
// keeping the user's existing name / product untouched. Changing the TikTok link
// clears any verification badge server-side, since the verified @username no
// longer matches.
export default function EditAccountLinks({
  profile,
  product,
}: {
  profile: UserProfile | null
  product: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [bank, setBank] = useState(profile?.bank_account ?? '')
  const [tiktok, setTiktok] = useState(profile?.tiktok_url ?? '')
  const [youtube, setYoutube] = useState(profile?.youtube_url ?? '')
  const [instagram, setInstagram] = useState(profile?.instagram_url ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  function reset() {
    setBank(profile?.bank_account ?? '')
    setTiktok(profile?.tiktok_url ?? '')
    setYoutube(profile?.youtube_url ?? '')
    setInstagram(profile?.instagram_url ?? '')
    setError('')
    setDone('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setDone('')
    if (!bank.trim()) return setError('Please enter your bank account number.')
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
          // Keep name / product as-is; the links and bank account are editable.
          name: profile?.name ?? '',
          bank_account: bank,
          product: product ?? '',
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
      setDone('Saved. Your account details have been updated.')
      router.refresh()
      setTimeout(() => setOpen(false), 900)
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
    <>
      <button
        type="button"
        onClick={() => {
          reset()
          setOpen(true)
        }}
        className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        title="Change your bank account number and the TikTok / YouTube / Instagram links on your account"
      >
        ✏️ Edit account
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <form onSubmit={submit} className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-md w-full p-5">
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-base font-semibold text-white">Edit your account details</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <p className="text-xs text-zinc-500 mt-1 mb-4">
              Update your payout bank account and the accounts you comment from. TikTok is required;
              YouTube and Instagram are optional. Each link can only be registered by one person.
              Changing your TikTok link means your account will need to be verified again.
            </p>

            <div className="space-y-4">
              <div>
                <label className={labelCls}>
                  Bank account number <span className="text-emerald-500">*</span>
                </label>
                <input
                  className={inputCls}
                  value={bank}
                  onChange={(e) => setBank(e.target.value)}
                  placeholder="For your payouts"
                  inputMode="numeric"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={labelCls}>
                  TikTok profile link <span className="text-emerald-500">*</span>
                </label>
                <input
                  className={inputCls}
                  value={tiktok}
                  onChange={(e) => setTiktok(e.target.value)}
                  placeholder="https://www.tiktok.com/@you"
                  inputMode="url"
                />
              </div>
              <div>
                <label className={labelCls}>
                  YouTube channel link <span className="text-zinc-600">(optional)</span>
                </label>
                <input
                  className={inputCls}
                  value={youtube}
                  onChange={(e) => setYoutube(e.target.value)}
                  placeholder="https://www.youtube.com/@you"
                  inputMode="url"
                />
              </div>
              <div>
                <label className={labelCls}>
                  Instagram profile link <span className="text-zinc-600">(optional)</span>
                </label>
                <input
                  className={inputCls}
                  value={instagram}
                  onChange={(e) => setInstagram(e.target.value)}
                  placeholder="https://www.instagram.com/you"
                  inputMode="url"
                />
              </div>
            </div>

            {error && <p className="text-sm text-red-400 mt-4">{error}</p>}
            {done && <p className="text-sm text-emerald-400 mt-4">{done}</p>}

            <div className="flex justify-end gap-2 mt-6">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-3 py-1.5 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save links'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  )
}
