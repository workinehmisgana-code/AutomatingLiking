import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Reports which env vars the running server can see (presence only, no secret
// values). Hit /api/health in the deployed app to confirm configuration.
export function GET() {
  return NextResponse.json({
    NODE_ENV: process.env.NODE_ENV ?? null,
    BETTER_AUTH_SECRET: Boolean(process.env.BETTER_AUTH_SECRET),
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? null, // not sensitive
    DATABASE_URL: Boolean(process.env.DATABASE_URL),
    GOOGLE_CLIENT_ID: Boolean(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    BLOB_READ_WRITE_TOKEN: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
  })
}
