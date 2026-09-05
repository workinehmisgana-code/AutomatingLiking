'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function fmtWhen(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export default function CommentsList({
  comments,
  product,
  generatedAt = null,
}: {
  comments: string[]
  product: string | null
  generatedAt?: string | null
}) {
  const [q, setQ] = useState('')
  const [copied, setCopied] = useState<number | null>(null)

  const items = useMemo(() => {
    const s = q.toLowerCase().trim()
    return comments.map((c, i) => ({ c, i })).filter(({ c }) => !s || c.toLowerCase().includes(s))
  }, [q, comments])

  async function onCopy(text: string, i: number) {
    const ok = await copyText(text)
    if (ok) {
      setCopied(i)
      setTimeout(() => setCopied((cur) => (cur === i ? null : cur)), 1500)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-1">
        <h1 className="text-xl font-bold text-white">Comments</h1>
        <Link
          href="/"
          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg px-2.5 py-1.5 hover:bg-zinc-800 transition-colors"
        >
          ← Links
        </Link>
      </div>
      <p className="text-sm text-zinc-500 mb-5">
        Click a comment to copy it, then paste it under the video.
      </p>
      {product && generatedAt && (
        <p className="text-xs text-zinc-600 -mt-3 mb-5">
          Freshly rewritten {fmtWhen(generatedAt)} · updated automatically every 24h
        </p>
      )}

      {/* Filter */}
      {comments.length > 8 && (
        <input
          className="w-full mb-4 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
          placeholder="Filter comments…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}

      {/* List */}
      {items.length === 0 ? (
        <div className="text-center py-16">
          {q ? (
            <p className="text-sm text-zinc-500">No comments match your filter.</p>
          ) : (
            <>
              <p className="text-4xl mb-3">🕓</p>
              <p className="text-lg font-medium text-zinc-300">No comments yet</p>
              <p className="text-sm text-zinc-500 mt-2">
                Your admin hasn&apos;t switched any product into the comment pool. Check back soon.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(({ c, i }) => (
            <button
              key={i}
              onClick={() => onCopy(c, i)}
              className="w-full text-left flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 hover:border-zinc-600 hover:bg-zinc-900 transition-colors group"
              title="Click to copy"
            >
              <span className="flex-1 text-sm text-zinc-200 break-words">{c}</span>
              <span
                className={`shrink-0 text-xs rounded px-2 py-1 transition-colors ${
                  copied === i
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 group-hover:bg-zinc-700 group-hover:text-zinc-200'
                }`}
              >
                {copied === i ? 'Copied ✓' : 'Copy'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
