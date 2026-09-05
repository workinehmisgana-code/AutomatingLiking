import { betterAuth } from 'better-auth'
import { pool } from './db'

export const auth = betterAuth({
  // Better Auth manages its own tables (user, session, account, verification)
  // on this Postgres pool. Run `npx @better-auth/cli@latest migrate` to create them.
  database: pool,
  // BETTER_AUTH_SECRET and BETTER_AUTH_URL are read from the environment.
  // Better Auth only trusts BETTER_AUTH_URL's origin by default (the Vercel URL),
  // so local dev at localhost:3000 gets "Invalid origin". Allow it explicitly.
  trustedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
})

export type Session = typeof auth.$Infer.Session
