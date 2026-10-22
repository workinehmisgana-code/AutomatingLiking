'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/auth-client'
import { validateAllProfileLinks, REFERRAL_SHARE, ETHIOPIAN_BANKS } from '@/lib/config'
import { normalizeReferralCode } from '@/lib/referrals'
import type { UserProfile } from '@/lib/db'

// Products a new user can pick to work on (deactivated ones are not offered).

export default function Onboarding({
  initial,
  email,
  suggestedName,
  canEnterReferral,
  contactOnly = false,
  tiktokOnly = false,
  bankNameOnly = false,
}: {
  /** True when an existing worker only lacks the bank name. */
  bankNameOnly?: boolean
  initial: UserProfile | null
  email: string
  suggestedName: string
  /** Whether the referral field is offered. False once somebody is already
   *  recorded — it is a one-time question, and the form says so rather than
   *  showing a box that would be rejected. */
  canEnterReferral: boolean
  /** True when everything else is already filled in and only the phone or
   *  Telegram is missing — an existing worker, not a new registration. */
  contactOnly?: boolean
  /** True when the only thing wrong is a TikTok link that does not name an
   *  account. Also an existing worker, and the same reasoning: say which one
   *  field is being asked for rather than presenting the whole form again. */
  tiktokOnly?: boolean
}) {
  const router = useRouter()
  const [name, setName] = useState(initial?.name ?? suggestedName ?? '')
  const [bank, setBank] = useState(initial?.bank_account ?? '')
  // The bank: one of the list, or "Other" with the name typed in. A stored name
  // that is not on the list opens as Other with it filled in.
  const storedBank = initial?.bank_name ?? ''
  const [bankPick, setBankPick] = useState(
    storedBank ? (ETHIOPIAN_BANKS.includes(storedBank) ? storedBank : '__other') : ''
  )
  const [bankOther, setBankOther] = useState(
    storedBank && !ETHIOPIAN_BANKS.includes(storedBank) ? storedBank : ''
  )
  const bankName = bankPick === '__other' ? bankOther.trim() : bankPick
  // CLEARED when it is the link being replaced. A box holding the very text
  // that was refused invites pressing Save on it unchanged, and then reading
  // the same error as a bug.
  const [tiktok, setTiktok] = useState(tiktokOnly ? '' : initial?.tiktok_url ?? '')
  const [youtube, setYoutube] = useState(initial?.youtube_url ?? '')
  const [instagram, setInstagram] = useState(initial?.instagram_url ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [telegram, setTelegram] = useState(initial?.telegram ?? '')
  const [referral, setReferral] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!name.trim()) return setError('Please enter your name.')
    if (!bank.trim()) return setError('Please enter your bank account number.')
    if (!bankName) {
      return setError(bankPick === '__other' ? 'Type the name of your bank.' : 'Choose your bank.')
    }
    if (!tiktok.trim()) return setError('Please enter your TikTok profile link.')
    const linkError = validateAllProfileLinks({
      tiktok_url: tiktok,
      youtube_url: youtube,
      instagram_url: instagram,
    })
    if (linkError) return setError(linkError)
    // EITHER ONE. Some people have a phone and no Telegram and some the other
    // way round; asking for both would shut out people we can already reach.
    if (!phone.trim() && !telegram.trim()) {
      return setError('Enter a phone number or a Telegram username — either one is enough.')
    }
    setSaving(true)
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          bank_account: bank,
          bank_name: bankName,
          tiktok_url: tiktok,
          youtube_url: youtube,
          instagram_url: instagram,
          phone,
          telegram,
          referral_code: canEnterReferral ? referral : '',
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
          <h1 className="text-xl font-bold text-white">
            {tiktokOnly
              ? 'Send your TikTok link again'
              : bankNameOnly
                ? 'Add your bank'
                : contactOnly
                ? 'Add your phone or Telegram'
                : 'Complete your profile'}
          </h1>
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
        {tiktokOnly ? (
          // Sent here by the TikTok gate. Everything else is already filled in
          // below, and saying so is what keeps the form from reading as a demand
          // to register all over again.
          <p className="text-sm text-zinc-400 mb-6 leading-relaxed">
            Everything else is already filled in. Paste your{' '}
            <b className="text-zinc-200">TikTok profile link</b> below — the one with
            your <b className="text-zinc-200">@username</b> in it, like{' '}
            <span className="font-mono text-zinc-300">tiktok.com/@yourusername</span> — and
            press Save. Your work and your pay are untouched.
          </p>
        ) : bankNameOnly ? (
          <p className="text-sm text-zinc-400 mb-6 leading-relaxed">
            Everything else is already filled in. Choose the{' '}
            <b className="text-zinc-200">bank your account is at</b> below — or type it if it
            is not in the list — and press Save. Your work and your pay are untouched.
          </p>
        ) : contactOnly ? (
          // An existing worker, sent here by the gate. Everything else is
          // already filled in below; without saying so, the form reads as a
          // demand to register all over again.
          <p className="text-sm text-zinc-400 mb-6 leading-relaxed">
            Everything else is already filled in. Add a{' '}
            <b className="text-zinc-200">phone number</b> or a{' '}
            <b className="text-zinc-200">Telegram username</b> below — either one — and
            press Save. Your work and your pay are untouched.
          </p>
        ) : (
          <p className="text-sm text-zinc-500 mb-6">
            We need a few details before you start. This is saved to your account
            {email ? ` (${email})` : ''} and you can change it later.
          </p>
        )}

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

          <div>
            <label className={labelCls}>Bank <span className="text-emerald-500">*</span></label>
            <select
              className={inputCls}
              value={bankPick}
              onChange={(e) => setBankPick(e.target.value)}
            >
              <option value="">Choose your bank…</option>
              {ETHIOPIAN_BANKS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
              <option value="__other">Other — type it</option>
            </select>
            {bankPick === '__other' && (
              <input
                className={inputCls + ' mt-2'}
                value={bankOther}
                onChange={(e) => setBankOther(e.target.value)}
                placeholder="Your bank's name"
                autoComplete="off"
              />
            )}
          </div>

          <div className="pt-2">
            <p className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
              How we reach you
            </p>
            <p className="text-xs text-zinc-500 mb-3">
              One of the two is enough. This is how you are contacted about a payment,
              a rejected link or a blocked account — an email address alone is not
              something people read.
            </p>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>
                  Phone number{' '}
                  <span className="text-zinc-500 font-normal">
                    {telegram.trim() ? '(optional)' : '— or Telegram below'}
                  </span>
                </label>
                <input
                  className={inputCls}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="0912345678"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </div>
              <div>
                <label className={labelCls}>
                  Telegram username{' '}
                  <span className="text-zinc-500 font-normal">
                    {phone.trim() ? '(optional)' : '— or the phone number above'}
                  </span>
                </label>
                <input
                  className={inputCls}
                  value={telegram}
                  onChange={(e) => setTelegram(e.target.value)}
                  placeholder="@yourname"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          </div>

          <div className="pt-2">
            <p className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
              Accounts you comment from
            </p>
            <p className="text-xs text-zinc-500 mb-3">
              TikTok is required to start; YouTube and Instagram are optional. Each link can only be
              registered by one person.
            </p>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>TikTok profile link <span className="text-emerald-500">*</span></label>
                <input className={inputCls} value={tiktok} onChange={(e) => setTiktok(e.target.value)} placeholder="https://www.tiktok.com/@you" inputMode="url" />
                <p className="text-xs text-zinc-500 mt-1">
                  Must show your @username, like{' '}
                  <span className="font-mono text-zinc-400">tiktok.com/@yourusername</span>. A video
                  link or a short vm.tiktok.com link will not work.
                </p>
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

          {/* Asked ONCE, here. It cannot be set later, so the form says that
              plainly rather than letting somebody assume they can add it
              after they have started working. */}
          {canEnterReferral && (
            <div className="pt-2">
              <label className={labelCls}>
                Referral username <span className="text-zinc-600">(optional)</span>
              </label>
              <input
                className={inputCls}
                value={referral}
                onChange={(e) => setReferral(e.target.value)}
                placeholder="Who invited you?"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
              />
              {referral.trim() !== '' && normalizeReferralCode(referral) === '' && (
                <p className="text-xs text-amber-400 mt-1">
                  That is not a username. It should be letters and numbers, like{' '}
                  <span className="text-zinc-300">abebek</span>.
                </p>
              )}
              <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">
                Asked once, when you register — it cannot be
                changed later, so leave it blank if you are not sure.{' '}
                <b className="text-zinc-400">Nothing is taken off what you earn.</b> Their
                {' '}{Math.round(REFERRAL_SHARE * 100)}% is paid on top, by us.
              </p>
            </div>
          )}

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
