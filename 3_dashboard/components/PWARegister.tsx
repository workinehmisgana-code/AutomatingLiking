'use client'

import { useEffect } from 'react'

// Registers the service worker so the dashboard is installable as a PWA
// ("Add to home screen") and qualifies as a Trusted Web Activity target.
export default function PWARegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!('serviceWorker' in navigator)) return
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* SW registration is best-effort; the app works without it */
      })
    }
    window.addEventListener('load', onLoad)
    return () => window.removeEventListener('load', onLoad)
  }, [])
  return null
}
