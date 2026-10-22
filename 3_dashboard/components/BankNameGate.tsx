import Link from 'next/link'

/**
 * Shown to somebody who registered before the bank name was asked for.
 *
 * The same shape as ContactGate, for the same reason: a worker of several
 * weeks dropped into the registration form without a word reads that as having
 * been reset. This says what is needed and that nothing else has moved.
 */
export default function BankNameGate({ name }: { name?: string | null }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="max-w-md w-full text-center">
        <p className="text-4xl mb-4">🏦</p>
        <h1 className="text-lg font-semibold text-white">
          {name ? `${name}, we need one more thing` : 'One more thing'}
        </h1>
        <p className="text-sm text-zinc-400 mt-3 leading-relaxed">
          Tell us <b className="text-zinc-200">which bank</b> your account number is at, to
          carry on working. Pick it from the list, or type it if it is not there.
        </p>
        <p className="text-sm text-zinc-500 mt-3 leading-relaxed">
          Your payment is sent to that bank — without it, the transfer cannot be made.
        </p>

        <Link
          href="/onboarding"
          className="inline-block mt-6 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-xl px-5 py-3 transition-colors"
        >
          Add my bank
        </Link>

        <p className="text-xs text-zinc-600 mt-5 leading-relaxed">
          Nothing else has changed. Your work, your pay and your links are exactly where
          you left them, and they come back the moment this is saved.
        </p>
      </div>
    </div>
  )
}
