'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { PROMO_PLATFORMS, PROMO_PAY_BIRR, PROMO_DAILY_LIMIT_PER_PLATFORM } from '@/lib/config'

export default function PromoIntro({
  product,
  onDone,
}: {
  product: string | null
  onDone?: () => void
}) {
  const router = useRouter()
  const done = onDone ?? (() => router.refresh())
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!PROMO_PLATFORMS.some((p) => (urls[p.key] ?? '').trim())) {
      return setError('Add at least one dedicated account link to continue.')
    }
    setSaving(true)
    try {
      const res = await fetch('/api/promo/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(urls),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(d?.error || 'Could not save. Please try again.')
        return
      }
      done() // now onboarded → reload so the page shows the task
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500'

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white">Repost &amp; earn</h1>
        <Link
          href="/"
          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Links
        </Link>
      </div>
      <p className="text-sm text-zinc-500 mb-5">
        A quick one-time setup before you start.
      </p>

      {/* How it works */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 mb-6">
        <h2 className="text-sm font-semibold text-zinc-200 mb-3">How it works</h2>
        <ol className="space-y-2 text-sm text-zinc-400 list-decimal list-inside">
          <li>
            Create a <span className="text-zinc-200">dedicated account</span> on each platform
            (TikTok, YouTube, Instagram) just for advertising{' '}
            <span className="text-emerald-300 font-medium">{product ?? 'the products we promote'}</span>.
          </li>
          <li>Download a video we provide and post it to those dedicated accounts.</li>
          <li>
            Use one of the ready-made <span className="text-zinc-200">captions</span> (title + tags) —
            just click to copy it.
          </li>
          <li>
            Paste the link of your post back here. You earn{' '}
            <span className="text-emerald-300 font-medium">{PROMO_PAY_BIRR} birr</span> for each
            platform link.
          </li>
          <li>
            Post at most{' '}
            <span className="text-zinc-200">{PROMO_DAILY_LIMIT_PER_PLATFORM} video per day</span> on
            each account.
          </li>
        </ol>
      </div>

      {/* Dedicated account links */}
      <form onSubmit={submit} className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <h2 className="text-sm font-semibold text-zinc-200 mb-1">
          Your dedicated accounts <span className="text-emerald-500">*</span>
        </h2>
        <p className="text-xs text-zinc-500 mb-4">
          Paste the profile links of the accounts you created for this. These are separate from your
          personal accounts. Add at least one to continue — you can post to the others later.
        </p>
        <div className="space-y-3">
          {PROMO_PLATFORMS.map((p) => (
            <div key={p.key}>
              <label className="block text-xs text-zinc-400 mb-1">{p.label} profile link</label>
              <input
                className={inputCls}
                value={urls[p.key] ?? ''}
                onChange={(e) => setUrls((u) => ({ ...u, [p.key]: e.target.value }))}
                placeholder={`https://…/@your-${p.key}-account`}
                inputMode="url"
              />
            </div>
          ))}
        </div>
        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="mt-5 w-full bg-emerald-600 text-white font-medium rounded-lg px-4 py-2.5 hover:bg-emerald-500 transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save and start'}
        </button>
      </form>
    </div>
  )
}
