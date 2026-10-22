import Link from 'next/link'
import { TIKTOK_PROFILE_EXAMPLE } from '@/lib/config'

/**
 * Shown to somebody whose stored TikTok link does not name their account.
 *
 * WHY THEY HAVE TO DO IT AND WE CANNOT. A `vm.tiktok.com/ZS9…` link, or one
 * typed without the @, does not contain the username anywhere in it — the
 * account is behind a redirect, or was never written down. So the verification
 * check has nothing to look for, and every comment this person writes goes
 * uncredited while their account looks, from the inside, completely normal.
 * That is the thing this gate stops, and the only person who can supply the
 * missing name is the one holding the phone.
 *
 * THE OLD LINK IS SHOWN. "Your link is wrong" with nothing beside it invites
 * the reply "no it isn't, it opens my profile" — which is true, it does. Seeing
 * the stored text is what makes the difference between that link and the one
 * being asked for obvious.
 *
 * It is a hold, not a punishment: nothing is deleted, no pay is lost, and it
 * clears the moment the new link is saved. The copy says so, because a worker
 * who thinks they have been blocked stops working and does not come back.
 */
export default function TiktokGate({
  name,
  current,
}: {
  name?: string | null
  current?: string | null
}) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="max-w-md w-full text-center">
        <p className="text-4xl mb-4">🔗</p>
        <h1 className="text-lg font-semibold text-white">
          {name ? `${name}, please send your TikTok link again` : 'Please send your TikTok link again'}
        </h1>
        <p className="text-sm text-zinc-400 mt-3 leading-relaxed">
          The link saved on your account does not show your{' '}
          <b className="text-zinc-200">@username</b>, so we cannot check your comments
          against it — and work we cannot check is work we cannot pay for.
        </p>

        {current && (
          <div className="mt-5 text-left bg-zinc-900/60 border border-zinc-800 rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">Saved now</p>
            <p className="text-xs text-zinc-400 break-all font-mono">{current}</p>
            <p className="text-[11px] uppercase tracking-wide text-zinc-500 mt-3 mb-1">Needed</p>
            <p className="text-xs text-emerald-400 break-all font-mono">{TIKTOK_PROFILE_EXAMPLE}</p>
          </div>
        )}

        <div className="mt-5 text-left text-sm text-zinc-400 leading-relaxed">
          <p className="text-zinc-300 font-medium mb-1">How to get it</p>
          <p>
            Open <b className="text-zinc-200">your own profile</b> in the TikTok app, tap the
            arrow or the three dots at the top, choose{' '}
            <b className="text-zinc-200">Copy link</b>, and paste it below. Or type it
            yourself: <span className="font-mono text-zinc-300">tiktok.com/@yourusername</span>.
          </p>
          <p className="text-zinc-500 mt-2">
            A link to one of your videos will not work, and neither will a short
            vm.tiktok.com link — neither of them has your username in it.
          </p>
        </div>

        <Link
          href="/onboarding"
          className="inline-block mt-6 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-xl px-5 py-3 transition-colors"
        >
          Send my TikTok link
        </Link>

        <p className="text-xs text-zinc-600 mt-5 leading-relaxed">
          Nothing else has changed. Your work, your pay and your links are exactly where
          you left them, and they come back the moment this is saved.
        </p>
      </div>
    </div>
  )
}
