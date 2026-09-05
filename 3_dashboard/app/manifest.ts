import type { MetadataRoute } from 'next'

// Web App Manifest — makes the dashboard installable as a PWA and is the source
// Bubblewrap reads to build the Android (TWA) app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Repost & Earn Dashboard',
    short_name: 'Dashboard',
    description: 'Comment, repost and earn — your tasks and payments in one place.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0a0a0a',
    theme_color: '#059669',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
