import { Pool, type QueryResultRow } from 'pg'

/**
 * The product sites' own databases (PurifyText, ProHumanly, …), reached with
 * plain `pg` rather than the Prisma client the standalone Support Desk used.
 *
 * Each project has its own database, so pools are cached per connection string.
 * Kept on globalThis so dev-mode hot reload does not leak a new pool per edit.
 *
 * TABLE AND COLUMN NAMES are the products' Prisma schema as stored: the models
 * are @@map-ped to snake_case tables ("user", api_key, humanizer_history, …) but
 * the fields are not mapped, so every column is camelCase and must be quoted
 * ("clerkId", "createdAt"). The products own these schemas and their
 * migrations; nothing here creates or alters a table.
 */
const g = globalThis as unknown as { supportPools?: Map<string, Pool> }
const pools = (g.supportPools ??= new Map<string, Pool>())

function poolFor(databaseUrl: string): Pool {
  let p = pools.get(databaseUrl)
  if (!p) {
    p = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
    })
    pools.set(databaseUrl, p)
  }
  return p
}

/** One query against a product's database. */
export async function q<T extends QueryResultRow = QueryResultRow>(
  databaseUrl: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const { rows } = await poolFor(databaseUrl).query<T>(sql, params)
  return rows
}

/**
 * Neon sits behind a serverless proxy, so a query can fail purely because the
 * connection wobbled during the handshake. Those failures are transient and a
 * retry clears them; anything else (bad SQL, constraint violation) is re-thrown
 * immediately.
 */
function isTransient(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? ''
  const message = error instanceof Error ? error.message : ''
  return (
    ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '08006', '08001'].includes(code) ||
    /Connection terminated|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(message)
  )
}

export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isTransient(error) || attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt ** 2))
    }
  }
  throw lastError
}

export function describeDbError(error: unknown, projectLabel: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timeout|ECONNRESET|ENOTFOUND|Connection terminated/i.test(message)) {
    return `Could not reach the ${projectLabel} database after 3 attempts. Press Look up again.`
  }
  if (/relation .* does not exist|column .* does not exist/i.test(message)) {
    return `The ${projectLabel} database doesn't have the expected tables or columns, so credit usage can't be read for this project.`
  }
  return message
}

/** The user columns every product's schema has (see customer.ts). */
export const USER_COLUMNS = [
  'id', 'clerkId', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt',
  'credits', 'extraCredits', 'subscriptionPlan', 'subscriptionType', 'productId',
  'nextResetDate', 'maxWordsPerRequest', 'teamId',
]
export const USER_SELECT = USER_COLUMNS.map((c) => `u."${c}"`).join(', ')

export type ProductUser = {
  id: string
  clerkId: string
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  createdAt: Date
  updatedAt: Date
  credits: number
  extraCredits: number
  subscriptionPlan: string | null
  subscriptionType: string | null
  productId: string | null
  nextResetDate: Date | null
  maxWordsPerRequest: number
  teamId: string | null
}

/** The account with this email, case-insensitively, or null. */
export async function findUserByEmail(databaseUrl: string, email: string): Promise<ProductUser | null> {
  const rows = await withDbRetry(() =>
    q<ProductUser>(
      databaseUrl,
      `SELECT ${USER_SELECT} FROM "user" u WHERE lower(u.email) = lower($1) LIMIT 1`,
      [email.trim()]
    )
  )
  return rows[0] ?? null
}
