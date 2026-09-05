'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import CommentsList from '@/components/CommentsList'
import { PageSkeleton, PageError } from '@/components/PageLoader'

type Data = { comments: string[]; product: string | null; generatedAt: string | null }

// Static page shell → instant navigation. The data loads client-side here.
export default function CommentsClient() {
  const router = useRouter()
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState(false)

  const load = useCallback(async () => {
    setErr(false)
    try {
      const res = await fetch('/api/comments', { cache: 'no-store' })
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
  if (!data) return <PageSkeleton title="comments" variant="comments" />
  return <CommentsList comments={data.comments} product={data.product} generatedAt={data.generatedAt} />
}
