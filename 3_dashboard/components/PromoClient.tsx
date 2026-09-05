'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import PromoTask, { type CaptionGroup } from '@/components/PromoTask'
import PromoIntro from '@/components/PromoIntro'
import { PageSkeleton, PageError } from '@/components/PageLoader'
import type { PromoVideoUser } from '@/lib/db'

type Data =
  // Admin switched the whole task off — nothing else is sent.
  | { taskEnabled: false }
  | { taskEnabled?: true; intro: true; product: string | null }
  | {
      taskEnabled?: true
      intro: false
      product: string | null
      videos: PromoVideoUser[]
      captionGroups: CaptionGroup[]
      downloadUsedToday: boolean
      nextDownloadResetMs: number
    }

// Static page shell → instant navigation. The data loads client-side here.
export default function PromoClient() {
  const router = useRouter()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState(false)

  const load = useCallback(async () => {
    setErr(false)
    try {
      const res = await fetch('/api/promo', { cache: 'no-store' })
      if (res.status === 401) return router.replace('/')
      if (!res.ok) throw new Error()
      setData(await res.json())
    } catch {
      setErr(true)
    }
  }, [router])

  useEffect(() => {
    load()
  }, [load])

  if (err) return <PageError onRetry={load} />
  if (!data) return <PageSkeleton title="repost & earn" variant="promo" />
  // Off: say so plainly rather than showing an empty video list. Every promo
  // endpoint is blocked server-side too, so this is a message, not the gate.
  if (data.taskEnabled === false) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <p className="text-4xl mb-3">⏸</p>
        <p className="text-lg font-medium text-zinc-300">Repost &amp; earn is paused</p>
        <p className="text-sm text-zinc-500 mt-2">
          This task is currently turned off. Your existing submissions and pay are unaffected —
          check back later, or keep commenting in the meantime.
        </p>
        <Link
          href="/"
          className="inline-block mt-6 text-sm text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg px-4 py-2 transition-colors"
        >
          ← Back to links
        </Link>
      </div>
    )
  }
  if (data.intro) return <PromoIntro product={data.product} onDone={load} />
  return (
    <PromoTask
      videos={data.videos}
      product={data.product}
      captionGroups={data.captionGroups}
      downloadUsedToday={data.downloadUsedToday}
      nextDownloadResetMs={data.nextDownloadResetMs}
      onReload={load}
    />
  )
}
