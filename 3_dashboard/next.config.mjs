/** @type {import('next').NextConfig} */
const nextConfig = {
  // Where the build output goes. Defaults to .next, which is also where
  // `next dev` keeps its own compiled chunks — and the two formats are not
  // compatible. Running a production build while the dev server is serving
  // replaces the dev chunks under it, and the next request dies with
  // "Cannot find module './vendor-chunks/<something>.js'" from a manifest
  // pointing at a file that no longer exists.
  //
  // So a verification build goes somewhere else:
  //
  //   NEXT_DIST_DIR=.next-verify npx next build
  //
  // Dev is untouched, and nobody has to notice a build happened.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  experimental: {
    // Keep pg out of the webpack bundle so its dynamic/optional native requires
    // (pg-native, pg-cloudflare) resolve at runtime instead of bundling to
    // `undefined`. Do NOT externalize better-auth: it's pure JS, and externalizing
    // it breaks SSR resolution of client components that import better-auth/react.
    serverComponentsExternalPackages: ['pg'],
  },
}

export default nextConfig
