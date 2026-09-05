'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  videoUrl: string
  tiktokUrl: string | null
  /** ISO timestamp of the last check, or null if never checked. */
  checkedAt: string | null
  email: string
}

function handleOf(url: string | null): string | null {
  const m = (url || '').match(/@([^/?#\s]+)/)
  return m?.[1] ?? null
}

/**
 * The verification gate. Shown instead of the links list until the user proves
 * they can post a comment from the TikTok account they registered.
 *
 * This is deliberately a hold, not a punishment: nothing is deleted, no pay is
 * lost, and it clears itself the moment a check finds their comment. The copy
 * says so, because a user who thinks they have been banned stops working.
 */
export default function VerifyGate({ videoUrl, tiktokUrl, checkedAt, email }: Props) {
  const router = useRouter()
  const [checking, setChecking] = useState(false)
  const handle = handleOf(tiktokUrl)

  async function recheck() {
    setChecking(true)
    try {
      // Verification runs out of band (a checker reads the video's commenters),
      // so this just re-reads our own status.
      router.refresh()
      await new Promise((r) => setTimeout(r, 900))
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 mb-6">
        <div className="flex items-start gap-3">
          <span className="text-2xl leading-none">⏸</span>
          <div>
            <h1 className="text-lg font-semibold text-white">
              One step before you can start
            </h1>
            <p className="text-sm text-zinc-400 mt-1 leading-relaxed">
              We need to confirm that the TikTok account you registered is really yours and can
              post comments. Do this once and your links appear straight away.
            </p>
          </div>
        </div>
      </div>

      <h2 className="text-sm font-semibold text-white mb-3">What to do</h2>
      <ol className="space-y-3 mb-6">
        {[
          <>
            Open this video:{' '}
            <a
              href={videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:text-emerald-300 break-all underline underline-offset-2"
            >
              {videoUrl}
            </a>
          </>,
          <>
            Comment <span className="text-zinc-200">anything at all</span> on it — &ldquo;nice&rdquo;,
            &ldquo;😂&rdquo;, whatever you like.{' '}
            <span className="text-amber-300">
              Do not mention any product and do not paste one of our comments.
            </span>{' '}
            This is only to prove the account is yours.
          </>,
          <>
            Comment from{' '}
            {handle ? (
              <>
                the account you registered, <span className="text-zinc-200">@{handle}</span>
              </>
            ) : (
              <span className="text-zinc-200">the TikTok account you registered</span>
            )}
            . If you would rather use a different account, update your TikTok link on the profile
            first, then comment from that one.
          </>,
          <>
            Wait for the check. It runs regularly — once your comment is found, this page turns
            into your links automatically.
          </>,
        ].map((node, i) => (
          <li key={i} className="flex gap-3 text-sm">
            <span className="shrink-0 w-6 h-6 rounded-full bg-zinc-800 text-zinc-300 text-xs flex items-center justify-center tabular-nums">
              {i + 1}
            </span>
            <span className="text-zinc-300 leading-relaxed">{node}</span>
          </li>
        ))}
      </ol>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 mb-6 text-sm">
        <div className="text-zinc-400">
          <span className="text-zinc-500">Registered TikTok account: </span>
          {handle ? (
            <a
              href={`https://www.tiktok.com/@${handle}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-200 hover:text-emerald-400"
            >
              @{handle}
            </a>
          ) : (
            <span className="text-amber-300">none saved — add it on your profile first</span>
          )}
        </div>
        <div className="text-zinc-500 text-xs mt-1">
          {checkedAt
            ? `Last checked ${new Date(checkedAt).toLocaleString()} — your comment was not found on the video yet.`
            : 'Not checked yet.'}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 transition-colors"
        >
          Open the video →
        </a>
        <button
          onClick={recheck}
          disabled={checking}
          className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
        >
          {checking ? 'Checking…' : "I've commented — check again"}
        </button>
      </div>

      <p className="text-xs text-zinc-600 mt-6 leading-relaxed">
        Nothing you have already earned is affected — this is a pause, not a block. If you have
        commented and are still held after a while, message the admin from this account ({email}).
      </p>
    </div>
  )
}
