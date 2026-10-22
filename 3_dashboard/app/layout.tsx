import type { Metadata, Viewport } from 'next'
import './globals.css'
import PWARegister from '@/components/PWARegister'
import GenreRegistryClient from '@/components/GenreRegistryClient'
import { ensureGenreRegistry } from '@/lib/genreStore'

export const metadata: Metadata = {
  applicationName: 'Dashboard',
  title: 'Repost & Earn Dashboard',
  description: 'Comment, repost and earn — your tasks and payments in one place.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Dashboard',
  },
  icons: {
    icon: '/icons/icon-192.png',
    apple: '/icons/apple-touch-icon.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#059669',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The genres added in the admin, applied here on the server and handed to the
  // browser so both sides agree (see lib/genreRegistry.ts).
  const genres = await ensureGenreRegistry().catch(() => [])
  return (
    <html lang="en">
      <body>
        <GenreRegistryClient list={genres} />
        {children}
        <PWARegister />
      </body>
    </html>
  )
}
