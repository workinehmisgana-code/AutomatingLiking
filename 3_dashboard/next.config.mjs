/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep pg out of the webpack bundle so its dynamic/optional native requires
    // (pg-native, pg-cloudflare) resolve at runtime instead of bundling to
    // `undefined`. Do NOT externalize better-auth: it's pure JS, and externalizing
    // it breaks SSR resolution of client components that import better-auth/react.
    serverComponentsExternalPackages: ['pg'],
  },
}

export default nextConfig
