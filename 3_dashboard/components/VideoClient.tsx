'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import VideoTask from '@/components/VideoTask'
import { PageSkeleton, PageError } from '@/components/PageLoader'
import type { VideoStatus, VideoSubmission } from '@/lib/db'

type Data = {
  status: VideoStatus | null
  submissions: VideoSubmission[]
  product: string | null
  taskEnabled?: boolean
}

// Static page shell → instant navigation. The data loads client-side here.
export default function VideoClient() {
  const router = useRouter()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState(false)

  const load = useCallback(async () => {
    setErr(false)
    try {
      const res = await fetch('/api/videos', { cache: 'no-store' })
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
  if (!data) return <PageSkeleton title="video task" variant="video" />
  if (data.taskEnabled === false) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <p className="text-4xl mb-3">🎬</p>
        <p className="text-lg font-medium text-zinc-200">Video task is currently unavailable</p>
        <p className="text-sm text-zinc-500 mt-1">The video task has been paused. Please check back later.</p>
        <button onClick={() => router.replace('/')} className="mt-6 text-sm text-emerald-400 hover:text-emerald-300">
          ← Back to the dashboard
        </button>
      </div>
    )
  }
  return (
    <VideoTask
      status={data.status}
      submissions={data.submissions}
      product={data.product}
      onReload={load}
    />
  )
}
