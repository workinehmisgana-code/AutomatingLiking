// Minimal service worker for PWA installability.
// This app is highly dynamic and auth-gated, so we deliberately DO NOT cache
// HTML/pages (that would risk showing stale, wrong-user content). We only
// cache the app icons, and otherwise pass every request straight to the network.

const CACHE = 'dashboard-static-v1'
const PRECACHE = [
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  // Only handle GETs for our own origin icons from cache; everything else is
  // network-only so pages/auth/API are always fresh.
  if (request.method === 'GET' && new URL(request.url).pathname.startsWith('/icons/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)))
    return
  }
  // Network passthrough (satisfies the "has a fetch handler" install criterion).
  event.respondWith(fetch(request))
})
