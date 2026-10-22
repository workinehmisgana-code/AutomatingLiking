'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/auth-client'

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

  const [result, setResult] = useState<{ status: string; message: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [newUrl, setNewUrl] = useState(tiktokUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')

  /**
   * Point the account at a different TikTok profile, from here.
   *
   * THIS IS THE PAGE WHERE THEY FIND OUT. Being told the account is too young,
   * or that the comment cannot be found, and then having to hunt for where the
   * link is edited, is how somebody gives up — and the answer to both problems
   * is usually a different account. The field is on the screen that raised the
   * question.
   *
   * It re-sends the WHOLE profile because /api/profile takes the whole thing
   * and rejects a partial one; the current values are fetched first so that
   * changing the link cannot quietly blank a phone number. The server
   * canonicalises and validates, so its complaint is the one shown.
   */
  async function saveLink() {
    const url = newUrl.trim()
    if (!url) {
      setSaveErr('Paste your TikTok profile link first.')
      return
    }
    setSaving(true)
    setSaveErr('')
    try {
      const cur = await fetch('/api/profile').then((r) => r.json()).catch(() => null)
      const p = (cur?.profile ?? {}) as Record<string, unknown>
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: p.name ?? '',
          bank_account: p.bank_account ?? '',
          youtube_url: p.youtube_url ?? '',
          instagram_url: p.instagram_url ?? '',
          phone: p.phone ?? '',
          telegram: p.telegram ?? '',
          tiktok_url: url,
        }),
      })
      const d = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setSaveErr(d.error || 'Could not save that link.')
        return
      }
      // The old verdict was recorded against the OLD handle, so it stops
      // counting by itself (see isTiktokVerified). Clear what is on screen so
      // nothing stale is read as a verdict on the new account.
      setResult(null)
      setEditing(false)
      router.refresh()
    } catch {
      setSaveErr('Could not reach the server. Try again.')
    } finally {
      setSaving(false)
    }
  }

  /**
   * Run the check now, rather than refreshing and hoping.
   *
   * This used to only call router.refresh(), because verification ran out of
   * band in a Python checker: the worker pressed the button, nothing visibly
   * happened, and they pressed it again. The dashboard can read the video's
   * comments itself, so pressing the button does the thing the button says.
   */
  async function recheck() {
    setChecking(true)
    setResult(null)
    try {
      const res = await fetch('/api/verify-tiktok', { method: 'POST' })
      const d = (await res.json().catch(() => ({}))) as {
        verified?: boolean
        status?: string
        message?: string
        error?: string
      }
      if (!res.ok) {
        setResult({ status: 'unreadable', message: d.error || 'Could not check just now.' })
        return
      }
      setResult({ status: String(d.status ?? ''), message: String(d.message ?? '') })
      // Verified: the links are waiting behind this screen, so go and get them.
      if (d.verified) router.refresh()
    } catch {
      setResult({ status: 'unreadable', message: 'Could not reach the server. Try again.' })
    } finally {
      setChecking(false)
    }
  }

  // AN ACCOUNT THAT IS TOO NEW IS NOT A "TRY AGAIN". Pressing the button a
  // second time cannot change how old it is, so that one answer is styled as
  // the end of the road and says what to do instead, rather than sitting in
  // the same neutral box as "we could not find your comment yet".
  const terminal = result?.status === 'too_new'

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
          {checking ? 'Checking…' : "I've commented — check now"}
        </button>
      </div>

      {result && (
        <div
          className={
            'mt-4 rounded-xl border p-4 text-sm leading-relaxed ' +
            (result.status === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-200'
              : terminal
                ? 'border-rose-500/40 bg-rose-500/5 text-rose-200'
                : 'border-zinc-700 bg-zinc-900/60 text-zinc-300')
          }
        >
          <div className="font-medium mb-1">
            {result.status === 'ok'
              ? '✓ Verified'
              : terminal
                ? 'This account cannot be used'
                : 'Not yet'}
          </div>
          <div>{result.message}</div>
          {terminal && (
            <button
              onClick={() => setEditing(true)}
              className="inline-block mt-3 text-sm font-medium text-white bg-rose-600 hover:bg-rose-500 rounded-lg px-4 py-2 transition-colors"
            >
              Use a different TikTok account
            </button>
          )}
        </div>
      )}

      {/* CHANGING THE ACCOUNT, from the page that raised the question. Shown
          collapsed so it does not compete with the thing most people are here
          to do, which is comment and press Check. */}
      <div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm text-zinc-300 font-medium">Your TikTok account</div>
            <div className="text-xs text-zinc-500 font-mono break-all mt-0.5">
              {tiktokUrl || 'none saved'}
            </div>
          </div>
          {!editing && (
            <button
              onClick={() => {
                setNewUrl(tiktokUrl ?? '')
                setSaveErr('')
                setEditing(true)
              }}
              className="text-sm text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg px-3 py-1.5 transition-colors shrink-0"
            >
              Change
            </button>
          )}
        </div>

        {editing && (
          <div className="mt-3">
            <input
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://www.tiktok.com/@yourusername"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-emerald-500"
            />
            <p className="text-xs text-zinc-500 mt-2 leading-relaxed">
              It has to show your <b className="text-zinc-300">@username</b>. A link to one of
              your videos will not work, and neither will a short vm.tiktok.com link — neither
              of them has your username in it.
            </p>
            {saveErr && <p className="text-xs text-rose-300 mt-2">{saveErr}</p>}
            <div className="flex items-center gap-2 mt-3">
              <button
                onClick={saveLink}
                disabled={saving}
                className="text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg px-4 py-2 transition-colors"
              >
                {saving ? 'Saving…' : 'Save this link'}
              </button>
              <button
                onClick={() => {
                  setEditing(false)
                  setSaveErr('')
                }}
                disabled={saving}
                className="text-sm text-zinc-400 hover:text-zinc-200 px-2 py-2 transition-colors"
              >
                Cancel
              </button>
            </div>
            <p className="text-xs text-zinc-600 mt-3 leading-relaxed">
              Saving a different account starts the check again for that one — comment from it,
              then press Check.
            </p>
          </div>
        )}
      </div>

      {/* A WAY OUT. This screen holds somebody before they can do anything
          else, and without this the only exits are the browser's back button
          and clearing cookies — which matters most on a shared phone, where
          the person who needs to sign in is not the one currently signed in. */}
      <div className="mt-6">
        <button
          onClick={async () => {
            await signOut()
            window.location.href = '/'
          }}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Sign out
        </button>
      </div>

      <p className="text-xs text-zinc-600 mt-6 leading-relaxed">
        Nothing you have already earned is affected — this is a pause, not a block. If you have
        commented and are still held after a while, message the admin from this account ({email}).
      </p>
    </div>
  )
}
