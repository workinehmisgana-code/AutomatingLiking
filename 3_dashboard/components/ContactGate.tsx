import Link from 'next/link'

/**
 * Shown to somebody who registered before a phone number or Telegram username
 * was asked for, instead of their links.
 *
 * A REDIRECT WOULD HAVE BEEN WRONG HERE. A person who has been working for
 * weeks, dropped without explanation into a form asking for their bank account
 * again, reads that as having been reset — or as the site being broken — and
 * the first thing they do is message somebody to ask. This says what changed,
 * what is needed, that either one will do, and that nothing else about their
 * account has moved.
 *
 * It is a hold, not a punishment: nothing is deleted, no pay is lost, and it
 * clears the moment the form is saved. The copy says so, because a worker who
 * thinks they have been blocked stops working and does not come back.
 */
export default function ContactGate({ name }: { name?: string | null }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="max-w-md w-full text-center">
        <p className="text-4xl mb-4">📱</p>
        <h1 className="text-lg font-semibold text-white">
          {name ? `${name}, we need one more thing` : 'One more thing'}
        </h1>
        <p className="text-sm text-zinc-400 mt-3 leading-relaxed">
          Add your <b className="text-zinc-200">phone number</b> or your{' '}
          <b className="text-zinc-200">Telegram username</b> to carry on working.
          Either one is enough — you do not need both.
        </p>
        <p className="text-sm text-zinc-500 mt-3 leading-relaxed">
          It is how you are reached about a payment, a rejected link or a problem with
          your account. Email alone does not reach anyone.
        </p>

        <Link
          href="/onboarding"
          className="inline-block mt-6 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-xl px-5 py-3 transition-colors"
        >
          Add my phone or Telegram
        </Link>

        <p className="text-xs text-zinc-600 mt-5 leading-relaxed">
          Nothing else has changed. Your work, your pay and your links are exactly where
          you left them, and they come back the moment this is saved.
        </p>
      </div>
    </div>
  )
}
